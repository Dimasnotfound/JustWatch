from __future__ import annotations

import unittest
from unittest.mock import patch

from api import universal


class UniversalResolverTests(unittest.TestCase):
    def test_blocks_private_addresses(self) -> None:
        blocked = [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
        ]
        for address in blocked:
            with self.subTest(address=address):
                self.assertFalse(universal._is_public_ip(address))

    def test_allows_representative_public_addresses(self) -> None:
        self.assertTrue(universal._is_public_ip("1.1.1.1"))
        self.assertTrue(universal._is_public_ip("8.8.8.8"))
        self.assertTrue(universal._is_public_ip("2606:4700:4700::1111"))

    def test_rejects_local_url_without_dns_lookup(self) -> None:
        with self.assertRaisesRegex(ValueError, "lokal atau privat"):
            universal.validate_public_url("http://127.0.0.1/video.mp4")
        with self.assertRaisesRegex(ValueError, "lokal atau privat"):
            universal.validate_public_url("http://localhost/video.mp4")

    def test_audio_webm_gets_audio_mime_type(self) -> None:
        format_info = {
            "ext": "webm",
            "protocol": "https",
            "vcodec": "none",
            "acodec": "opus",
        }
        self.assertEqual(
            universal._mime_type(format_info, "https://cdn.example/video.webm"),
            "audio/webm",
        )

    def test_expiration_is_read_from_signed_url(self) -> None:
        expires = universal._expiration_from_url(
            "https://cdn.example/video.mp4?expire=1893456000"
        )
        self.assertEqual(expires, "2030-01-01T00:00:00Z")

    @patch("api.universal.validate_public_url", side_effect=lambda value, **_: value)
    def test_parses_cobalt_redirect(self, _validate) -> None:
        result = universal._parse_cobalt_response(
            {
                "status": "redirect",
                "url": "https://cdn.example/video.mp4",
                "filename": "clip.mp4",
            },
            "https://social.example/post/1",
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["provider"], "cobalt")
        self.assertEqual(result["sources"][0]["mimeType"], "video/mp4")
        self.assertTrue(result["sources"][0]["hasAudio"])
        self.assertTrue(result["sources"][0]["hasVideo"])

    @patch("api.universal.validate_public_url", side_effect=lambda value, **_: value)
    def test_cobalt_picker_ignores_photos(self, _validate) -> None:
        result = universal._parse_cobalt_response(
            {
                "status": "picker",
                "picker": [
                    {"type": "photo", "url": "https://cdn.example/image.jpg"},
                    {"type": "video", "url": "https://cdn.example/video-1.mp4"},
                    {"type": "video", "url": "https://cdn.example/video-2.mp4"},
                ],
            },
            "https://social.example/post/2",
        )
        self.assertIsNotNone(result)
        self.assertEqual(len(result["sources"]), 2)
        self.assertEqual(result["sources"][0]["entryIndex"], 1)

    @patch("api.universal.validate_public_url", side_effect=lambda value, **_: value)
    def test_format_sort_prefers_progressive_video(self, _validate) -> None:
        info = {
            "id": "example",
            "title": "Example",
            "formats": [
                {
                    "format_id": "video-only",
                    "url": "https://cdn.example/720.mp4",
                    "ext": "mp4",
                    "protocol": "https",
                    "height": 720,
                    "vcodec": "avc1",
                    "acodec": "none",
                },
                {
                    "format_id": "progressive",
                    "url": "https://cdn.example/360.mp4",
                    "ext": "mp4",
                    "protocol": "https",
                    "height": 360,
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                },
            ],
        }
        sources, _entries = universal._extract_sources(info)
        self.assertEqual(sources[0]["formatId"], "progressive")
        self.assertTrue(sources[0]["hasAudio"])
        self.assertTrue(sources[0]["hasVideo"])


if __name__ == "__main__":
    unittest.main()
