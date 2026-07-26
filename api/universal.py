from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import socket
import sys
import time
import urllib.error
import urllib.request
from functools import lru_cache
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.parse import parse_qs, urlparse

import yt_dlp
from yt_dlp.utils import DownloadError

MAX_BODY_BYTES = 16_384
MAX_URL_LENGTH = 4_096
MAX_SOURCES = 18
MAX_ENTRIES = 12
SOCKET_TIMEOUT_SECONDS = 20
COBALT_TIMEOUT_SECONDS = 30
MAX_COBALT_RESPONSE_BYTES = 1_000_000

BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal")
PROTECTED_AVAILABILITY = {
    "needs_auth",
    "premium_only",
    "subscriber_only",
    "private",
    "needs_subscription",
}
ALLOWED_SOURCE_SCHEMES = {"http", "https"}
SAFE_RESPONSE_HEADERS = {
    "accept",
    "accept-language",
    "origin",
    "referer",
}

MIME_BY_EXTENSION = {
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "mov": "video/quicktime",
    "webm": "video/webm",
    "ogv": "video/ogg",
    "ogg": "video/ogg",
    "m3u8": "application/vnd.apple.mpegurl",
    "mpd": "application/dash+xml",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
}


class QuietLogger:
    def debug(self, _message: str) -> None:
        return

    def warning(self, _message: str) -> None:
        return

    def error(self, _message: str) -> None:
        return


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _is_public_ip(address: str) -> bool:
    try:
        value = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False

    return not (
        value.is_private
        or value.is_loopback
        or value.is_link_local
        or value.is_multicast
        or value.is_reserved
        or value.is_unspecified
    )


@lru_cache(maxsize=128)
def _resolve_hostname(hostname: str, port: int) -> tuple[str, ...]:
    return tuple(
        sorted(
            {
                record[4][0]
                for record in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
            }
        )
    )


def validate_public_url(value: str, *, resolve_dns: bool = True) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_URL_LENGTH:
        raise ValueError("URL tidak valid.")

    parsed = urlparse(value.strip())
    if parsed.scheme.lower() not in ALLOWED_SOURCE_SCHEMES:
        raise ValueError("Hanya URL HTTP atau HTTPS yang didukung.")
    if not parsed.hostname:
        raise ValueError("URL tidak memiliki nama domain.")
    if parsed.username or parsed.password:
        raise ValueError("URL dengan kredensial tidak diizinkan.")
    if parsed.port not in (None, 80, 443):
        raise ValueError("Port URL tidak diizinkan.")

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(BLOCKED_HOST_SUFFIXES):
        raise ValueError("Alamat lokal atau privat tidak diizinkan.")

    try:
        direct_ip = ipaddress.ip_address(hostname)
    except ValueError:
        direct_ip = None

    if direct_ip is not None:
        if not _is_public_ip(str(direct_ip)):
            raise ValueError("Alamat lokal atau privat tidak diizinkan.")
        return value.strip()

    if resolve_dns:
        try:
            addresses = _resolve_hostname(hostname, parsed.port or 443)
        except OSError as error:
            raise ValueError("Nama domain tidak dapat ditemukan.") from error

        if not addresses or any(not _is_public_ip(address) for address in addresses):
            raise ValueError("Domain mengarah ke alamat lokal atau privat.")

    return value.strip()


def _mime_type(format_info: dict[str, Any], source_url: str) -> str:
    extension = str(format_info.get("ext") or "").lower()
    protocol = str(format_info.get("protocol") or "").lower()
    path = urlparse(source_url).path.lower()
    vcodec = str(format_info.get("vcodec") or "none").lower()
    acodec = str(format_info.get("acodec") or "none").lower()

    if "m3u8" in protocol or path.endswith(".m3u8"):
        return "application/vnd.apple.mpegurl"
    if "dash" in protocol or path.endswith(".mpd"):
        return "application/dash+xml"
    if vcodec == "none" and acodec != "none":
        if extension == "webm":
            return "audio/webm"
        if extension in {"ogg", "opus"}:
            return "audio/ogg"
    return MIME_BY_EXTENSION.get(extension, "")


def _source_kind(format_info: dict[str, Any], source_url: str, mime_type: str) -> str:
    protocol = str(format_info.get("protocol") or "").lower()
    path = urlparse(source_url).path.lower()
    vcodec = str(format_info.get("vcodec") or "none").lower()
    acodec = str(format_info.get("acodec") or "none").lower()

    if "m3u8" in protocol or "mpegurl" in mime_type or path.endswith(".m3u8"):
        return "hls"
    if "dash" in protocol or "dash+xml" in mime_type or path.endswith(".mpd"):
        return "dash"
    if vcodec == "none" and acodec != "none":
        return "audio"
    return "file"


def _expiration_from_url(source_url: str) -> str | None:
    query = parse_qs(urlparse(source_url).query)
    for key in ("expire", "expires", "expiry", "exp"):
        values = query.get(key)
        if not values or not values[0].isdigit():
            continue
        timestamp = int(values[0])
        if timestamp > 10_000_000_000:
            timestamp //= 1_000
        if timestamp > int(time.time()) - 86_400:
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))
    return None


def _safe_headers(*header_groups: Any) -> dict[str, str]:
    safe: dict[str, str] = {}
    for group in header_groups:
        if not isinstance(group, dict):
            continue
        for key, value in group.items():
            normalized = str(key).lower()
            if normalized in SAFE_RESPONSE_HEADERS and isinstance(value, str) and len(value) <= 1_024:
                safe[key] = value
    return safe


def _format_score(format_info: dict[str, Any], kind: str) -> tuple[int, int, float]:
    vcodec = str(format_info.get("vcodec") or "none").lower()
    acodec = str(format_info.get("acodec") or "none").lower()
    height = int(format_info.get("height") or 0)
    total_bitrate = float(format_info.get("tbr") or 0)

    has_video = vcodec != "none"
    has_audio = acodec != "none"

    if kind == "file" and has_video and has_audio:
        tier = 6
    elif kind == "hls" and has_video:
        tier = 5
    elif kind == "dash" and has_video and has_audio:
        tier = 4
    elif kind == "file" and has_video:
        tier = 3
    elif kind in {"hls", "dash"}:
        tier = 2
    elif kind == "audio":
        tier = 1
    else:
        tier = 0

    return tier, height, total_bitrate


def _label_for_format(format_info: dict[str, Any], kind: str) -> str:
    note = str(format_info.get("format_note") or "").strip()
    height = format_info.get("height")
    fps = format_info.get("fps")
    extension = str(format_info.get("ext") or "").upper()
    vcodec = str(format_info.get("vcodec") or "none").lower()
    acodec = str(format_info.get("acodec") or "none").lower()

    pieces: list[str] = []
    if height:
        pieces.append(f"{int(height)}p")
    elif note and note.lower() not in {"unknown", "default"}:
        pieces.append(note)
    elif kind == "audio":
        pieces.append("Audio")
    else:
        pieces.append(kind.upper())

    if fps and float(fps) > 30:
        pieces.append(f"{round(float(fps))}fps")
    if extension:
        pieces.append(extension)
    if vcodec != "none" and acodec == "none":
        pieces.append("video saja")
    if vcodec == "none" and acodec != "none":
        pieces.append("audio saja")

    return " · ".join(pieces)


def _format_to_source(
    format_info: dict[str, Any],
    common_headers: dict[str, Any] | None,
    entry_index: int,
) -> dict[str, Any] | None:
    source_url = format_info.get("url")
    if not isinstance(source_url, str) or not source_url.startswith(("http://", "https://")):
        return None

    try:
        validate_public_url(source_url)
    except ValueError:
        return None

    mime_type = _mime_type(format_info, source_url)
    kind = _source_kind(format_info, source_url, mime_type)
    if not mime_type and kind == "file":
        return None

    vcodec = str(format_info.get("vcodec") or "none")
    acodec = str(format_info.get("acodec") or "none")
    filesize = format_info.get("filesize") or format_info.get("filesize_approx")
    expires_at = _expiration_from_url(source_url)
    headers = _safe_headers(common_headers, format_info.get("http_headers"))

    source: dict[str, Any] = {
        "url": source_url,
        "mimeType": mime_type,
        "kind": kind,
        "origin": "yt-dlp",
        "formatId": str(format_info.get("format_id") or ""),
        "label": _label_for_format(format_info, kind),
        "entryIndex": entry_index,
        "width": format_info.get("width"),
        "height": format_info.get("height"),
        "fps": format_info.get("fps"),
        "bitrateKbps": format_info.get("tbr"),
        "fileSize": int(filesize) if isinstance(filesize, (int, float)) and filesize > 0 else None,
        "hasVideo": vcodec.lower() != "none",
        "hasAudio": acodec.lower() != "none",
        "videoCodec": None if vcodec.lower() == "none" else vcodec,
        "audioCodec": None if acodec.lower() == "none" else acodec,
    }

    if headers:
        source["httpHeaders"] = headers
    if expires_at:
        source["expiresAt"] = expires_at

    return {key: value for key, value in source.items() if value is not None and value != ""}


def _iter_entries(info: dict[str, Any]) -> list[dict[str, Any]]:
    if info.get("_type") not in {"playlist", "multi_video"}:
        return [info]

    entries = []
    for entry in info.get("entries") or []:
        if isinstance(entry, dict):
            entries.append(entry)
        if len(entries) >= MAX_ENTRIES:
            break
    return entries


def _extract_sources(info: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    candidates: list[tuple[tuple[int, int, float], dict[str, Any]]] = []
    media_entries: list[dict[str, Any]] = []

    for entry_index, entry in enumerate(_iter_entries(info)):
        availability = str(entry.get("availability") or "").lower()
        if availability in PROTECTED_AVAILABILITY:
            continue

        media_entries.append(
            {
                "index": entry_index,
                "id": entry.get("id"),
                "title": entry.get("title"),
                "thumbnail": entry.get("thumbnail"),
                "duration": entry.get("duration"),
            }
        )

        formats = list(entry.get("formats") or [])
        if entry.get("url") and not formats:
            formats.append(entry)

        for format_info in formats:
            if not isinstance(format_info, dict):
                continue
            source = _format_to_source(format_info, entry.get("http_headers") or info.get("http_headers"), entry_index)
            if source is None:
                continue
            score = _format_score(format_info, source["kind"])
            candidates.append((score, source))

    candidates.sort(key=lambda item: item[0], reverse=True)

    sources: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_variants: set[tuple[Any, ...]] = set()

    for _score, source in candidates:
        variant_key = (
            source.get("entryIndex"),
            source.get("kind"),
            source.get("height"),
            source.get("hasAudio"),
            source.get("mimeType"),
        )
        if source["url"] in seen_urls or variant_key in seen_variants:
            continue
        seen_urls.add(source["url"])
        seen_variants.add(variant_key)
        sources.append(source)
        if len(sources) >= MAX_SOURCES:
            break

    return sources, media_entries


def _build_ydl_options() -> dict[str, Any]:
    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
        "skip_download": True,
        "noplaylist": True,
        "playlistend": MAX_ENTRIES,
        "extract_flat": False,
        "socket_timeout": SOCKET_TIMEOUT_SECONDS,
        "retries": 1,
        "extractor_retries": 1,
        "fragment_retries": 0,
        "cachedir": False,
        "cookiefile": None,
        "cookiesfrombrowser": None,
        "username": None,
        "password": None,
        "videopassword": None,
        "geo_bypass": False,
        "check_formats": False,
        "ignore_no_formats_error": False,
    }

    node_path = shutil.which("node")
    if node_path:
        options["js_runtimes"] = {"node": {"path": node_path}}

    return options


def _cobalt_api_url() -> str | None:
    raw_url = os.getenv("COBALT_API_URL", "").strip()
    if not raw_url:
        return None

    parsed = urlparse(raw_url)
    if parsed.scheme.lower() not in ALLOWED_SOURCE_SCHEMES or not parsed.hostname:
        return None
    return raw_url.rstrip("/") + "/"


def _cobalt_authorization() -> str | None:
    explicit = os.getenv("COBALT_API_AUTHORIZATION", "").strip()
    if explicit:
        return explicit

    api_key = os.getenv("COBALT_API_KEY", "").strip()
    if api_key:
        return f"Api-Key {api_key}"

    bearer = os.getenv("COBALT_BEARER_TOKEN", "").strip()
    if bearer:
        return f"Bearer {bearer}"
    return None


def _cobalt_mime_type(filename: str, source_url: str) -> str:
    extension = ""
    for candidate in (filename, urlparse(source_url).path):
        basename = candidate.rsplit("/", 1)[-1].split("?", 1)[0]
        if "." in basename:
            extension = basename.rsplit(".", 1)[-1].lower()
            if extension:
                break
    return MIME_BY_EXTENSION.get(extension, "video/mp4")


def _cobalt_source(source_url: str, filename: str, label: str, entry_index: int = 0) -> dict[str, Any] | None:
    try:
        validate_public_url(source_url)
    except ValueError:
        return None

    mime_type = _cobalt_mime_type(filename, source_url)
    kind = "hls" if "mpegurl" in mime_type or urlparse(source_url).path.lower().endswith(".m3u8") else "file"
    expires_at = _expiration_from_url(source_url)
    source: dict[str, Any] = {
        "url": source_url,
        "mimeType": mime_type,
        "kind": kind,
        "origin": "cobalt",
        "label": label,
        "entryIndex": entry_index,
        "hasVideo": mime_type.startswith("video/") or kind == "hls",
        "hasAudio": True,
    }
    if expires_at:
        source["expiresAt"] = expires_at
    return source


def _parse_cobalt_response(payload: Any, input_url: str) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None

    status = str(payload.get("status") or "").lower()
    source_host = urlparse(input_url).hostname or "Sumber media"

    if status in {"redirect", "tunnel"}:
        source_url = payload.get("url")
        if not isinstance(source_url, str):
            return None
        filename = str(payload.get("filename") or "video.mp4")
        source = _cobalt_source(source_url, filename, "Cobalt video")
        if source is None:
            return None
        return {
            "title": filename,
            "pageUrl": input_url,
            "finalUrl": input_url,
            "sourceHost": source_host,
            "provider": "cobalt",
            "sources": [source],
            "warnings": ["Sumber Cobalt dapat berupa tunnel sementara dan perlu diproses ulang setelah kedaluwarsa."],
        }

    if status == "picker":
        sources: list[dict[str, Any]] = []
        for item_index, item in enumerate(payload.get("picker") or []):
            if not isinstance(item, dict) or str(item.get("type") or "").lower() != "video":
                continue
            source_url = item.get("url")
            if not isinstance(source_url, str):
                continue
            source = _cobalt_source(source_url, f"video-{item_index + 1}.mp4", f"Video {item_index + 1}", item_index)
            if source is not None:
                sources.append(source)
            if len(sources) >= MAX_SOURCES:
                break

        if not sources:
            return None
        return {
            "title": f"Media dari {source_host}",
            "pageUrl": input_url,
            "finalUrl": input_url,
            "sourceHost": source_host,
            "provider": "cobalt",
            "sources": sources,
            "warnings": ["Posting ini memiliki beberapa video. Pilih sumber dari daftar."],
        }

    return None


def resolve_with_cobalt(input_url: str) -> dict[str, Any] | None:
    endpoint = _cobalt_api_url()
    if endpoint is None:
        return None

    body = _json_bytes(
        {
            "url": input_url,
            "downloadMode": "auto",
            "videoQuality": "1080",
            "filenameStyle": "basic",
            "localProcessing": "disabled",
            "alwaysProxy": False,
        }
    )
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "JustWatchUniversal/1.0",
    }
    authorization = _cobalt_authorization()
    if authorization:
        headers["Authorization"] = authorization

    request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=COBALT_TIMEOUT_SECONDS) as response:
            response_body = response.read(MAX_COBALT_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        return None

    if len(response_body) > MAX_COBALT_RESPONSE_BYTES:
        return None

    try:
        payload = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return _parse_cobalt_response(payload, input_url)


def _friendly_error(error: Exception) -> str:
    message = str(error)
    lowered = message.lower()

    if "unsupported url" in lowered or "no suitable extractor" in lowered:
        return "Situs atau jenis URL ini belum didukung oleh resolver universal."
    if any(term in lowered for term in ("login", "sign in", "cookies", "private video", "members-only")):
        return "Konten memerlukan login atau cookie akun dan tidak diproses oleh JustWatch."
    if "drm" in lowered or "widevine" in lowered:
        return "Konten dilindungi DRM dan tidak dapat diproses."
    if any(term in lowered for term in ("geo", "not available in your country", "region")):
        return "Konten dibatasi berdasarkan wilayah sumber."
    if any(term in lowered for term in ("confirm you’re not a bot", "confirm you're not a bot", "captcha")):
        return "Platform meminta verifikasi anti-bot sehingga sumber tidak dapat diambil secara otomatis."
    if "video unavailable" in lowered or "not available" in lowered:
        return "Video tidak tersedia atau sudah dihapus."
    if "timed out" in lowered or "timeout" in lowered:
        return "Platform terlalu lama merespons."

    cleaned = re.sub(r"^ERROR:\s*", "", message, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*\(caused by.*$", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
    return cleaned[:500] or "Sumber tidak dapat diproses oleh resolver universal."


def resolve_with_ytdlp(input_url: str) -> dict[str, Any]:
    validated_url = validate_public_url(input_url)

    try:
        with yt_dlp.YoutubeDL(_build_ydl_options()) as ydl:
            info = ydl.extract_info(validated_url, download=False)
            info = ydl.sanitize_info(info)
    except DownloadError as error:
        raise ValueError(_friendly_error(error)) from error
    except Exception as error:
        raise ValueError(_friendly_error(error)) from error

    if not isinstance(info, dict):
        raise ValueError("Resolver tidak mengembalikan informasi media yang valid.")

    availability = str(info.get("availability") or "").lower()
    if availability in PROTECTED_AVAILABILITY:
        raise ValueError("Konten tidak bersifat publik dan tidak dapat diproses.")

    sources, media_entries = _extract_sources(info)
    if not sources:
        requested = info.get("requested_formats") or []
        if requested:
            raise ValueError(
                "Sumber ditemukan sebagai trek video dan audio terpisah, tetapi tidak ada format gabungan yang dapat diputar langsung."
            )
        raise ValueError("yt-dlp mengenali halaman tersebut, tetapi tidak menemukan sumber media publik yang dapat diputar.")

    webpage_url = info.get("webpage_url") or validated_url
    source_host = urlparse(webpage_url).hostname or urlparse(validated_url).hostname or "Sumber media"

    warnings: list[str] = []
    if not any(source.get("hasVideo") and source.get("hasAudio") for source in sources):
        if any(source.get("hasVideo") for source in sources):
            warnings.append("Format yang tersedia dapat memiliki trek audio dan video terpisah.")
    if any(source.get("expiresAt") for source in sources):
        warnings.append("Sebagian URL bersifat sementara dan perlu diproses ulang setelah kedaluwarsa.")

    result = {
        "title": info.get("title") or source_host,
        "pageUrl": validated_url,
        "finalUrl": webpage_url,
        "sourceHost": source_host,
        "provider": "yt-dlp",
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "id": info.get("id"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "isLive": bool(info.get("is_live")),
        "sources": sources,
        "entries": media_entries,
        "warnings": warnings,
    }
    return {key: value for key, value in result.items() if value is not None and value != []}


def process_payload(payload: Any) -> tuple[int, dict[str, Any]]:
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "Body JSON tidak valid."}

    input_url = payload.get("url")
    if not isinstance(input_url, str) or not input_url.strip():
        return 400, {"ok": False, "error": "Masukkan URL yang valid."}

    try:
        validated_url = validate_public_url(input_url.strip())
        result = resolve_with_cobalt(validated_url)
        if result is None:
            result = resolve_with_ytdlp(validated_url)
        return 200, {"ok": True, "result": result}
    except ValueError as error:
        return 422, {"ok": False, "error": str(error)}
    except Exception:
        return 500, {"ok": False, "error": "Resolver universal mengalami kesalahan internal."}


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        content_length = int(self.headers.get("content-length") or 0)
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "error": "Body permintaan terlalu besar atau kosong."})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"ok": False, "error": "Body JSON tidak valid."})
            return

        status, response = process_payload(payload)
        self._send_json(status, response)

    def do_GET(self) -> None:  # noqa: N802
        self._send_json(405, {"ok": False, "error": "Gunakan metode POST."})


def _main() -> int:
    parser = argparse.ArgumentParser(description="JustWatch universal media resolver")
    parser.add_argument("--url", help="URL yang akan diproses")
    parser.add_argument("--stdin", action="store_true", help="Baca payload JSON dari stdin")
    args = parser.parse_args()

    if args.stdin:
        try:
            payload = json.loads(sys.stdin.read(MAX_BODY_BYTES))
        except json.JSONDecodeError:
            status, response = 400, {"ok": False, "error": "Body JSON tidak valid."}
        else:
            status, response = process_payload(payload)
    elif args.url:
        status, response = process_payload({"url": args.url})
    else:
        parser.error("gunakan --url atau --stdin")
        return 2

    print(json.dumps({"status": status, **response}, ensure_ascii=False, separators=(",", ":")))
    return 0 if status < 500 else 1


if __name__ == "__main__":
    raise SystemExit(_main())
