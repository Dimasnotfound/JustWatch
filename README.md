# JustWatch Universal Resolver

JustWatch adalah pemutar media publik dengan pipeline resolver berlapis. Aplikasi mencoba sumber langsung terlebih dahulu, adapter khusus situs berikutnya, lalu menggunakan yt-dlp sebagai fallback universal. File video tidak disimpan oleh aplikasi.

## Arsitektur

```text
URL pengguna
  ├─ Fast resolver
  │   ├─ URL MP4, WebM, OGG, HLS, dan DASH
  │   ├─ metadata og:video dan twitter:player:stream
  │   ├─ elemen video HTML5 dan JSON-LD contentUrl
  │   └─ adapter VidSonic
  └─ Universal resolver
      ├─ Cobalt self-hosted, bila dikonfigurasi
      └─ yt-dlp dengan ratusan extractor situs
```

Parser cepat sengaja menolak URL embed yang tidak memiliki tipe media yang jelas. Hal ini mencegah halaman player dianggap sebagai file video dan memastikan fallback universal dijalankan.

## Menjalankan secara lokal

Persyaratan:

- Node.js 22 atau lebih baru.
- Python 3.10 atau lebih baru.
- FFmpeg direkomendasikan untuk pengembangan dan provider yang memerlukan pemrosesan media.

Siapkan lingkungan Python terisolasi:

```bash
npm run setup:universal
```

Jalankan aplikasi:

```bash
npm run dev
```

Buka `http://localhost:3000`.

Pemeriksaan proyek:

```bash
npm run check
npm test
```

## Provider

### Fast resolver

Digunakan untuk sumber yang dapat diselesaikan tanpa mesin eksternal:

- URL langsung MP4, WebM, OGG, HLS `.m3u8`, dan MPEG-DASH `.mpd`.
- Metadata `og:video` dan `twitter:player:stream` yang benar-benar mengarah ke media.
- Elemen `<video>` dan `<source>`.
- Properti JSON-LD `contentUrl`.
- Halaman VidSonic yang memublikasikan manifest HLS bertanda tangan kepada browser.

### yt-dlp

`api/universal.py` menggunakan yt-dlp tanpa mengunduh file ke server. Resolver membaca metadata dan format yang tersedia, memprioritaskan format progresif yang memiliki audio dan video, lalu mengembalikan sumber yang dapat diputar.

Konfigurasi keamanan yang diterapkan:

- Tidak membaca cookie browser.
- Tidak menerima username atau password.
- Tidak melakukan geo-bypass.
- Tidak memproses URL lokal atau IP privat.
- Tidak mengembalikan kredensial atau header sensitif.
- Membatasi jumlah playlist, format, durasi proses, dan ukuran respons.

### Cobalt opsional

Cobalt hanya digunakan apabila instance milik sendiri dikonfigurasi. JustWatch tidak memakai API publik Cobalt secara otomatis.

Environment variable yang didukung:

```env
COBALT_API_URL=https://cobalt-api.example.com
COBALT_API_KEY=your-api-key
```

Alternatif autentikasi:

```env
COBALT_API_AUTHORIZATION=Api-Key your-api-key
# atau
COBALT_BEARER_TOKEN=your-bearer-token
```

Cobalt diprioritaskan sebelum yt-dlp ketika tersedia. Respons `redirect`, `tunnel`, dan video pada `picker` dapat diputar. Respons yang membutuhkan local processing akan diteruskan ke fallback yt-dlp karena JustWatch belum melakukan remux di browser.

## Deploy ke Vercel

1. Push proyek ke repository GitHub.
2. Impor repository di Vercel.
3. Vercel mendeteksi `api/resolve.js` sebagai fungsi Node.js.
4. Vercel mendeteksi `api/universal.py` dan menginstal `requirements.txt` untuk fungsi Python.
5. Tambahkan environment variable Cobalt hanya jika Anda mempunyai instance sendiri.

`vercel.json` memberi batas 15 detik untuk resolver cepat dan 60 detik untuk resolver universal.

Catatan: kemampuan extractor tertentu dapat berbeda antara lokal dan Vercel karena ketersediaan runtime JavaScript, FFmpeg, alamat IP server, pembatasan platform, dan batas fungsi serverless.

## Batasan nyata

Universal berarti cakupan luas, bukan jaminan seluruh situs. Resolver tetap dapat gagal pada:

- DRM seperti Widevine, FairPlay, atau PlayReady.
- Konten privat, berbayar, atau memerlukan login.
- CAPTCHA dan verifikasi anti-bot.
- URL yang terikat cookie, perangkat, wilayah, atau alamat IP tertentu.
- Platform yang baru mengubah struktur halaman atau API.
- Sumber yang melarang CORS atau pemutaran lintas situs.
- Video dengan trek audio dan video terpisah ketika tidak ada format progresif atau HLS yang dapat diputar langsung.

URL bertanda tangan dari YouTube, VidSonic, dan platform lain dapat kedaluwarsa. Pengguna perlu menempelkan ulang URL halaman agar resolver menghasilkan sumber baru.

Gunakan hanya untuk media publik yang boleh Anda akses, putar, atau simpan.
