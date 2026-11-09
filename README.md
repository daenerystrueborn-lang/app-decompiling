# Anime Stream & Download SDK (`MiruDL` + `AniFam`)

Complete documentation and production-ready JavaScript/TypeScript integration suite extracting and unifying the streaming and downloading architectures of **MiruDL (`v2.2.1`)** and **AniFam (`v0.2.9`)** for website integration.

## Features

- **MiruDL Provider (`src/providers/mirudl-client.js`)**:
  - AniLab catalog discovery (`home`, `categories`, `category`, `search` w/ concurrent missing-title enrichment, `post`).
  - Full Kyoto Player HMAC-SHA256 signing (`deriveKyotoInnerKey`, `signKyotoRequest`), `1500 ms` serialized request pacing, and `2000ms` / `5000ms` retry backoff on `401`/`429`.
  - Fixed `preferredQuality` resolution (correcting MiruDL's `DownloadService.runSingleJob` bug that ignored `preferred_quality`).
- **AniFam Provider (`src/providers/anifam-client.js` & `src/providers/anifam-playback.js`)**:
  - Automatic multi-domain failover across `anifam.net`, `anifam.buzz`, `anifam.top`, `anifam.cfd`, plus `GET config` domains and `429 Retry-After` handling.
  - Full **3-Mode Playback Controller**:
    1. **Direct HLS** (`kind === "hls"` with `mediaHeaders` and mirror origin rewriting).
    2. **Resolvable Iframe -> Native HLS** (`POST episodes/{id}/resolve` + TS image-prefix unwrapping).
    3. **Host-Locked Web Embed Fallback** (`<iframe>`).
  - 5-minute server cooldown tracking (`SourceCooldownBook`) and ordered mirror/server fallback chain.
- **Spoofed-Image MPEG-TS Unwrapper (`src/utils/ts-unwrapper.js`)**:
  - Buffer & Node `Transform` stream port of AniFam's `Q7/m` + `Q7/n` (`PNG`, `JPEG`, `GIF8`, `RIFF`, `BMP` prefix stripping aligned to 3x `0x47` sync bytes at 188-byte intervals inside 64 KiB).
- **Web Proxy & Concurrent HLS Downloader (`src/proxy/media-proxy.js`, `src/download/hls-downloader.js`)**:
  - HMAC-SHA256 signed M3U8 + segment + WebVTT proxy injecting custom headers, adding CORS headers, and streaming unwrapped TS chunks in real time.
  - 1..64 thread concurrent HLS downloader supporting both atomic `.part -> .mp4` disk saves and zero-disk direct browser HTTP streaming (`/api/download`).
- **Website Frontend SDK & Demo (`public/`, `examples/react-player-hook.jsx`)**:
  - Drop-in `AnimeSitePlayer` (with `hls.js`, WebVTT tracks, skip cues, server selector, iframe fallback) and `WebEpisodeDownloader` (server stream + in-browser progress downloader).
- **TypeScript Declarations & OpenAPI Spec**:
  - `types/index.d.ts` and `schemas/openapi.json`.

## Project Structure

```text
├── docs/
│   ├── INTEGRATION_GUIDE.md           # Step-by-step backend + website integration guide
│   └── STREAMING_AND_DOWNLOAD_LOGIC.md # Deep reverse-engineered spec of MiruDL & AniFam
├── examples/
│   └── react-player-hook.jsx          # Drop-in React / Next.js widget
├── public/
│   ├── index.html                     # Active anime stream & download web UI
│   ├── styles.css
│   └── js/
│       ├── site-app.js                # Interactive catalog, episodes, activity log & player wiring
│       ├── site-player.js             # Browser AnimeSitePlayer class (AniFam, MiruDL & Demo HLS)
│       └── web-downloader.js          # Browser WebEpisodeDownloader class
├── schemas/
│   └── openapi.json                   # OpenAPI 3.1.0 API specification
├── src/
│   ├── download/hls-downloader.js     # Concurrent HLS file + HTTP stream downloader
│   ├── providers/
│   │   ├── mirudl-client.js           # AniLab + Kyoto HMAC client
│   │   ├── anifam-client.js           # AniFam multi-domain failover & DTO client
│   │   └── anifam-playback.js         # 3-mode playback & cooldown state machine
│   ├── proxy/media-proxy.js           # HMAC-signed CORS/header/M3U8/TS-unwrap proxy
│   ├── utils/
│   │   ├── hls-parser.js              # Master/media M3U8 parser, scorer & rewriter
│   │   └── ts-unwrapper.js            # Spoofed-image TS header stripper + Transform stream
│   ├── server.js                      # Zero-dependency Node HTTP API & static server
│   └── index.js                       # Public ESM package entry point
├── tests/
│   └── run-tests.test.mjs             # Automated mock-backed test suite
├── types/
│   └── index.d.ts                     # TypeScript declarations
├── .env.example
└── package.json
```

## Quick Commands

```bash
# Run the automated test suite (Node built-in test runner, zero external deps)
npm test

# Start the unified API + Proxy + Web Demo server (default http://0.0.0.0:3000)
npm start
```

See [docs/STREAMING_AND_DOWNLOAD_LOGIC.md](docs/STREAMING_AND_DOWNLOAD_LOGIC.md) for full protocol and binary details, and [docs/INTEGRATION_GUIDE.md](docs/INTEGRATION_GUIDE.md) for website integration recipes.
