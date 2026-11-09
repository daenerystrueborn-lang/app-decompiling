# Detailed Streaming & Download Architecture: MiruDL (`2.2.1`) & AniFam (`0.2.9`)

This document details how **MiruDL** (`msr.mirudl.app` v2.2.1) and **AniFam** (`net.anifam.app` v0.2.9) discover catalog metadata, authenticate upstream APIs, resolve streams across multiple playback modes, unwrap disguised MPEG-TS segments, and download/encrypt episodes — along with how the JavaScript SDK in `src/` implements each mechanism cleanly for web integration.

---

## Table of Contents
1. [MiruDL (`msr.mirudl.app` v2.2.1)](#1-mirudl-msrmirudlapp-v221)
   - [1.1 Catalog Discovery (`MiruClient` & `AniLabKyotoSource`)](#11-catalog-discovery-miruclient--anilabkyotosource)
   - [1.2 Kyoto Player Request Signing & Rate Limiting (`kyotoPost`)](#12-kyoto-player-request-signing--rate-limiting-kyotopost)
   - [1.3 Episode & Stream Resolution (`getEpisodes`, `getEpisodeLanguages`, `resolveMaster`)](#13-episode--stream-resolution)
   - [1.4 Concurrent HLS Downloader (`HlsDownloader` & `DownloadService`)](#14-concurrent-hls-downloader-hlsdownloader--downloadservice)
   - [1.5 MiruDL Quality-Selection Bug & SDK Fix](#15-mirudl-quality-selection-bug--sdk-fix)
2. [AniFam (`net.anifam.app` v0.2.9)](#2-anifam-netanifamapp-v029)
   - [2.1 API Base, Headers, Auth & Multi-Domain Failover (`h8/a`, `v7/c`, `v7/h`)](#21-api-base-headers-auth--multi-domain-failover)
   - [2.2 API Surface & DTO Wire Schemas (`v7/c`, `F7/*`)](#22-api-surface--dto-wire-schemas)
   - [2.3 Playback Controller & 3-Mode Stream Architecture (`O7/J1`, `V1`, `U1`, `W1`, `b2`)](#23-playback-controller--3-mode-stream-architecture)
   - [2.4 Spoofed-Image MPEG-TS Unwrapping (`Q7/m` & `Q7/n`)](#24-spoofed-image-mpeg-ts-unwrapping)
   - [2.5 Mirror Origin Rewriting, 5-Minute Cooldowns & Error Fallback](#25-mirror-origin-rewriting-5-minute-cooldowns--error-fallback)
   - [2.6 Downloading, Quality Picker, Offline AES/CTR Cache & Casting](#26-downloading-quality-picker-offline-aesctr-cache--casting)
3. [Side-by-Side Comparison & Web Browser Integration Constraints](#3-side-by-side-comparison--web-browser-integration-constraints)

---

## 1. MiruDL (`msr.mirudl.app` v2.2.1)

MiruDL splits its pipeline cleanly between **AniLab** (catalog discovery & metadata) and **Kyoto Player** (episodes, audio tracks, and master `.m3u8` URLs), and runs **downloads-only** HLS assembly locally via a concurrent worker pool.

### 1.1 Catalog Discovery (`MiruClient` & `AniLabKyotoSource`)

- **Obfuscated AniDB String**: `MiruClient` stores `BASE` XOR-encoded with key `90` (`0x5A`). Decoding `[50, 46, 46, 42, 41, 96, 117, 117, 59, 52, 51, 62, 56, 116, 59, 42, 42]` yields `https://anidb.app` (used only for metadata/auxiliary lookups).
- **Primary Catalog Host (`AniLabKyotoSource`)**:
  - `ANILAB_API = "https://anilab2.amdapi.click/api"`
  - `KYOTO_API = "https://api.kyotoplayer.com"`
- **Catalog HTTP Headers**:
  ```http
  User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
  Accept: application/json
  X-Requested-With: XMLHttpRequest
  Referer: https://anilab2.amdapi.click/api/
  ```
- **Endpoints (`GET`)**:
  - `/home` → `{ sections: [{ name, posts: [{ id, poster }] }] }`
  - `/categories` → `{ categories: [{ id, name }] }`
  - `/category?id={id}&page={page}` → `{ posts: [...] }`
  - `/search?query={q}&page={page}` → `{ posts: [...] }`
    - Because `/search`, `/home`, and `/category` return posts without titles (or empty titles), `MiruClient.enrichTitles` fetches `/post?id={id}` concurrently across up to `8` worker threads (cached up to `500` titles in `mirudl_titles`).
  - `/post?id={id}` → full anime details (`title`, `synopsis`, `poster`, `genres`, `status`, etc.).

> JS implementation: `MiruDLClient` in `src/providers/mirudl-client.js`.

---

### 1.2 Kyoto Player Request Signing & Rate Limiting (`kyotoPost`)

All episode/server/stream requests go to `https://api.kyotoplayer.com` using **empty-body `POST`** requests authenticated via HMAC-SHA256 (`MiruClient.kyotoPost`).

1. **Serialized Request Pacing**:
   - Requests are serialized through a lock/queue enforcing a minimum **`1500 ms`** gap between consecutive calls (`KYOTO_LOCK`).
2. **401/429 Backoff Retries**:
   - Up to `3` attempts (`attempt = 0..2`).
   - On HTTP `401` or `429`, waits **`2000 ms`**, then **`5000 ms`** (`KYOTO_RETRY_DELAYS_MS = [2000L, 5000L]` — verified directly from Dalvik `fill-array-data` in `MiruClient.<clinit>`).
3. **2-Step Inner Key Derivation**:
   - `KYOTO_RAW_KEY` (32 bytes): `bcfb0102a27d4623de59016fcd8a511ff459d73f1671c2d2d7f1d2115e043308`
   - `KYOTO_CERT` (32 bytes): `482a900b2906766b2e8d3cf19fcf6d06d0b6c9569cb6305c9c43200a8e20979e`
   - Step A — XOR every byte `i` (`0..31`) of `KYOTO_RAW_KEY`:
     ```js
     xored[i] = rawKey[i] ^ ((i * 73 + 41) & 0xff);
     ```
   - Step B — HMAC-SHA256 of `KYOTO_CERT` (raw 32-byte key material) keyed by `xored`:
     ```js
     innerKey = HMAC_SHA256(key = xored, data = hexToBytes(KYOTO_CERT));
     ```
4. **Canonical Signing String & Headers**:
   - `tsSec = Math.floor(Date.now() / 1000)`
   - `nonce = base64UrlNoPad(randomBytes(16))`
   - `pathOnly = pathWithQuery.split('?')[0]` (query string is excluded from the signature!)
   - `EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"` (SHA-256 of `""`)
   - Canonical message:
     ```text
     POST
     {pathOnly}
     e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
     {tsSec}
     {nonce}
     132
     ```
   - Signature: `X-Kyoto-Sig = lowercaseHex(HMAC_SHA256(key = innerKey, data = canonical))`
   - Sent Headers:
     ```http
     User-Agent: Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36
     Accept: application/json
     app-id: com.kyotoplayer
     app-version: 132
     os-version: 13
     device-model: Pixel 7
     X-Kyoto-Ts: {tsSec}
     X-Kyoto-Nonce: {nonce}
     X-Kyoto-Sig: {sig}
     X-Kyoto-Cert: 482a900b2906766b2e8d3cf19fcf6d06d0b6c9569cb6305c9c43200a8e20979e
     ```

---

### 1.3 Episode & Stream Resolution

1. **Episode List**:
   - `POST https://api.kyotoplayer.com/episodes?id={animeId}&token=`
   - Returns `{ list: [{ id, number, name, filler, servers: [{ id, name, lang }] }] }`.
   - `MiruClient.parseServers` extracts `language` from `id.substring(id.lastIndexOf('/') + 1)` (default `"jpn"`).
2. **Episode Language / Server Probe**:
   - `POST https://api.kyotoplayer.com/servers?id={episodeId}&episode={episodeId}`
   - Returns `{ list: [...] }` and caches parsed `VideoSource` entries per `episodeId`.
3. **Stream URL Resolution (`resolveMaster`)**:
   - Server key format passed to Kyoto is `"{episodeId}/{language}"` (where `language` is `"jpn"` or `"eng"`, falling back to available language if the preferred track isn't present).
   - `POST https://api.kyotoplayer.com/stream?id={episodeId}&server={episodeId}/{language}`
   - Response contains `{ link: "https://.../master.m3u8" }`.
   - `MiruDL` attaches required media headers for downstream HLS fetches:
     - `User-Agent: Mozilla/5.0`
     - `Referer: https://play.app/`

---

### 1.4 Concurrent HLS Downloader (`HlsDownloader` & `DownloadService`)

MiruDL does not use a separate remuxing binary (`ffmpeg` is not bundled). Instead, `HlsDownloader.download(...)` concatenates MPEG-TS / fMP4 segments directly into `<SAF>/MiruDL Downloads/<Anime>/<Title>.mp4` via `.part` staging:

1. Fetch root playlist (`UA: Mozilla/5.0`, `Referer: https://play.app/`).
2. If `#EXT-X-STREAM-INF` is present, parse variants (`RESOLUTION=WxH`, `BANDWIDTH`) and fetch the selected variant media playlist.
3. Scan media playlist:
   - **Hard fail** if `#EXT-X-KEY` (with method != `NONE`) is found: encrypted HLS streams are rejected.
   - Extract `#EXT-X-MAP:URI="..."` initialization segment (if present, e.g., fMP4).
   - Extract all segment URIs (and `EXTINF` durations / relative URL resolution).
4. Write `#EXT-X-MAP` bytes first to `.part` (if present).
5. Spawn a fixed worker pool (`StorageSettings` clamps concurrency to **`1..64`**, defaulting to **`16`** segment threads and **`1`** concurrent episode job).
6. Each segment downloads with **3 retries** (`attempt * 500ms` delay) and flushes to disk **in exact sequence order** via bounded ready-buffer tracking, tracking download speed via an EMA (`0.3 * instant + 0.7 * prev`).
7. Atomically finalize/rename `.part` -> `.mp4` on completion, or clean up `.part` on error/cancel.

---

### 1.5 MiruDL Quality-Selection Bug & SDK Fix

In MiruDL `v2.2.1` decompiled bytecode:
- `DetailActivity` persists the user's selected `preferred_quality` (e.g., `"720p"`, `"480p"`, `"1080p"`) on the `DownloadJob`.
- However, `DownloadService.runSingleJob()` re-resolves `episodeId` via `resolveMaster` and calls the **9-argument** `HlsDownloader.download(masterUrl, tempFile, headers, threads, isCancelled, onProgress, null, null, 448)`, omitting `preferredQuality` (`null`), causing `HlsDownloader` to always fall back to `pickBestVariant()` (highest resolution)!

**SDK Fix (`src/utils/hls-parser.js`, `src/providers/mirudl-client.js`, `src/download/hls-downloader.js`)**:
- `pickVariantByQuality(variants, preferredQuality)` supports `"highest"`, `"lowest"`, `"auto"`, and explicit `"1080p"` / `"720p"` / `"480p"` / `"360p"` targets (matching exact height first, otherwise nearest `<= target`, otherwise closest `variantScore`), and `createHlsDownloadStream` / `downloadHlsToFile` always honor `preferredQuality`.

---

## 2. AniFam (`net.anifam.app` v0.2.9)

AniFam (`net.anifam.app`) is a feature-rich Kotlin + Media3 (ExoPlayer) + Kotlinx Serialization app supporting multi-domain failover, 3 distinct playback modes, disguised-image MPEG-TS unwrapping, mirror origin rewriting, offline AES/CTR encrypted storage, and DLNA/Chromecast casting.

### 2.1 API Base, Headers, Auth & Multi-Domain Failover

- **Primary Host**: `https://app.anifam.net/api/v1/app/`
- **Failover Domains (`v7/h`)**:
  - Static hardcoded defaults: `https://anifam.net`, `https://anifam.buzz`, `https://anifam.top`, `https://anifam.cfd`
  - Dynamically merged with domains returned by `GET config`.
- **Outgoing Headers (`h8/a`)**:
  ```http
  Accept: application/json
  X-App-Version: 20
  X-App-Platform: android
  ```
  - `Authorization: Bearer <token>` is injected **only** when sending to `app.anifam.net` (or explicitly configured auth host).
- **Failover & Rate-Limit Rules (`h8/a`)**:
  - **Idempotent (`GET`, `HEAD`)**: If the active domain fails with a network exception or HTTP `5xx` (or `408` / Cloudflare challenge), transparently retries across the remaining domains and caches the healthy domain as active.
  - **Non-idempotent (`POST`, `PUT`, `PATCH`, `DELETE`)**: Retries on the same request only when a pre-handshake / transport failure occurs safely, preventing double writes.
  - **Rate limit (`429`)**: Inspects `Retry-After` header; if delay `<= 20s`, sleeps once and retries; if `> 20s`, propagates the error (`AniFamApiError`).

> JS implementation: `AniFamClient` in `src/providers/anifam-client.js`.

---

### 2.2 API Surface & DTO Wire Schemas

Defined in `v7/c` and Kotlinx `$$serializer` classes in `F7/*`:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `config` | App config, dynamic failover domains, feature flags |
| `GET` | `genres` | Genre taxonomy |
| `GET` | `home` | Curated home shelves |
| `GET` | `schedule?date=&tz=` | Airing calendar |
| `GET` | `browse?...` | Filtered catalog pagination |
| `GET` | `search?q=&page=` | Text search |
| `GET` | `anime/{id}` | Full series details |
| `GET` | `anime/{id}/episodes` | `EpisodesDto` (`episodes` list) |
| `POST` | `episodes/{id}/play` | `{ track }` → **`PlaybackDto`** |
| `POST` | `episodes/{id}/resolve` | `{ track, serverId }` → resolved **`PlaybackSourceDto`** |
| `POST` | `episodes/{id}/download` | `{ track, quality }` → **`DownloadGrantDto`** |
| `POST` | `episodes/{id}/cast` | `{ track, url, subtitles }` → cast-friendly tokenized URLs |
| `POST` | `auth/login`, `auth/register` | Auth token acquisition |
| `POST` | `me/progress` | Watch history / resume syncing |
| `PUT/PATCH` | `me/watchlist/{anime_id}` | Watchlist management |

Key DTO fields (extracted from `F7/{g,h,j,q,s,x}` `$$serializer` wire names):
- **`PlaybackDto`**: `episodeId`, `track`, `tracks`, `sources`, `nextEpisode`, `prevEpisode`, `resumePosition`, `entitlements`.
- **`PlaybackSourceDto`**: `kind` (`"hls"` | `"iframe"`), `server`, `serverId`, `url`, `mirrors`, `mediaHeaders`, `qualities`, `subtitles`, `spriteVtt`, `thumb`, `skip` (`{ intro: {start, end}, outro: {start, end} }`), `duration`, `resolvable`, `embedUrl`, `backup`.
- **`DownloadGrantDto`**: `downloadId`, `keepUntil`, `quality`, `episodeId`, `animeId`, `track`, `sources` (plus optional top-level fallback fields when `sources` is empty; `.a()` selects the first source with `kind === "hls"`).

---

### 2.3 Playback Controller & 3-Mode Stream Architecture

Implemented across `O7/J1`, `V1`, `U1`, `W1`, and `b2` (`src/providers/anifam-playback.js`):

1. **Source Filtering & Ordering (`filterAndSortSources`)**:
   - Retains only valid sources:
     - Direct HLS: `kind === "hls"` and non-empty `url`
     - Resolvable Iframe: `kind === "iframe"` with non-null `serverId` AND (`resolvable !== false` OR host is `megaplay.buzz`)
     - Web-Embed Iframe: `kind === "iframe"` with non-empty `embedUrl` or `url`
   - Sorts `hls` sources ahead of `iframe` sources.
2. **Server Try-Order (`computeTryOrder`)**:
   - Priority tiers:
     1. Native-capable (`hls` or resolvable `iframe`), **not** on 5-minute cooldown
     2. Web-embed fallback sources (`iframe` without native resolution), **not** on cooldown
     3. Native-capable sources currently on cooldown
     4. Remaining sources
   - If the user has a saved `preferredServerKey` (`LocalSettings.k`), that server is hoisted to index 0 of the try order.
3. **Server Labels (`buildServerLabels`)**:
   - Primary source (`index === 0` or `!backup`) is labeled **`"AniFam"`**.
   - Backups are numbered **`"Backup Server 1"`, `"Backup Server 2"`, ...**.
   - Non-native web-embed sources are marked `isWebOnly = true` (shown with a `[Web]` badge in UI).
4. **The 3 Playback Modes**:
   - **Mode 1 (`hls` — Direct HLS)**:
     - Plays `source.url` (plus `source.mirrors`) directly via Media3 HLS with `source.mediaHeaders`.
   - **Mode 2 (`resolved_hls` — Resolvable Iframe -> Native HLS)**:
     - Calls `POST episodes/{id}/resolve` with `{ track, serverId: source.serverId }`.
     - Server extracts the raw CDN `.m3u8` + `mediaHeaders` + `mirrors` + `subtitles` + `skip`.
     - **Critical**: Attaches `Q7/m` + `Q7/n` (`TsUnwrapperDataSource`) to strip spoofed image headers disguised on segment responses!
   - **Mode 3 (`iframe` — Host-Locked WebView Fallback)**:
     - Used when no native HLS or resolvable server works (or when the user manually chooses a `[Web]` server).
     - Resolves relative `embedUrl` against the active AniFam origin and loads it inside a restricted WebView (`B7/E` + `y7.{a,b}`) that blocks top-level navigation to unknown third-party ad hosts.

---

### 2.4 Spoofed-Image MPEG-TS Unwrapping (`Q7/m` & `Q7/n`)

Some upstream iframe CDNs disguise `.ts` video segments as static image files (`image/png`, `image/jpeg`, etc.) by prepending a fake image header before valid 188-byte MPEG-TS packets. Standard browsers (`hls.js` / `<video>`) and players fail with demux errors unless these prefix bytes are stripped.

`Q7/m` (buffer detector) + `Q7/n` (Media3 `DataSource` wrapper) perform the following detection inside the **first `65,536` bytes (`64 KiB`)** of any segment:

1. **Header Magic Check** (`detectSpoofedImageSignature` — or forced scan when enabled):
   - **PNG**: `89 50 4E 47` (`\x89PNG`)
   - **JPEG**: `FF D8 FF`
   - **GIF8**: `47 49 46 38` (`GIF8`)
   - **RIFF (WebP)**: `52 49 46 46` (`RIFF`)
   - **BMP**: `42 4D` (`BM`)
2. **MPEG-TS Sync Lock (`findTsSyncOffset`)**:
   - Scans forward for offset `o` such that **three consecutive TS sync bytes (`0x47`)** align at exact 188-byte packet boundaries:
     ```text
     buf[o] === 0x47 && buf[o + 188] === 0x47 && buf[o + 376] === 0x47
     ```
3. **Strip Prefix**:
   - Drops bytes `0..o-1` and streams cleanly from offset `o` onward!

> JS implementation: `unwrapTsBuffer` and streaming `TsUnwrapperTransform` in `src/utils/ts-unwrapper.js`.

---

### 2.5 Mirror Origin Rewriting, 5-Minute Cooldowns & Error Fallback

- **Mirror Origin Rewriting (`V1.j` -> `rewriteAssetOriginForMirror`)**:
  - When a segment/sub-playlist fails on primary CDN host `P` and a mirror CDN `M` is switched in, AniFam replaces the `scheme://host[:port]` of any URL matching `P`'s host with `M`'s `scheme://host[:port]`, keeping the exact path/query intact (also applied to `.vtt` subtitle URLs when switching mirrors).
- **5-Minute Server Cooldown (`O7/b2` -> `SourceCooldownBook`)**:
  - Failed servers are keyed per `O7/V1.e` (`"main"` for `kind === "hls"`, `"server:<serverId>"` when `serverId` is present, or `"host:<hostname>"`) with a `300,000 ms` (5-minute) TTL so retries jump straight to healthy alternatives.
- **Fallback Chain (`handlePlaybackError`)**:
  1. Rotate through `candidateUrls` (`[...mirrors, url]` per `O7/V1.h`, starting at index `0`) on the current source.
  2. If mirrors are exhausted, record current server on 5-minute cooldown and try the next untried **native** server.
  3. On a native source failure, allow **1** automatic `hls` retry before leaving native mode.
  4. If all native sources fail, fall back to Mode 3 (`iframe` WebView).
  5. If HTTP `403` / entitlement rejection occurs, halt failover and show the entitlement/account prompt (`status: 'entitlement_required'`).

---

### 2.6 Downloading, Quality Picker, Offline AES/CTR Cache & Casting

- **Download Flow (`downloads/a`, `downloads/b`, `F7/x`, `F7/q`)**:
  1. Calls `POST episodes/{id}/download` with `{ track, quality }` -> `DownloadGrantDto`.
  2. Selects best quality via `F7/x`: picks the largest stream height `<= targetHeight` (e.g. `1080`, `720`, `480`), or the lowest available if all exceed `targetHeight`.
  3. Persists upstream `mediaHeaders` in `MediaHeaderBook` (`h4/l`) so background download workers send the required headers.
  4. Runs Media3 downloaders wrapped with `Q7/n` (`TsUnwrapper`) so downloaded files contain clean MPEG-TS / fMP4 payloads.
- **Offline Storage Encryption (`E/d0`, `h4/e`)**:
  - Offline downloads on Android can be stored encrypted in app storage using **`AES/CTR/NoPadding`**:
    - Master 16-byte key loaded/generated at `download.key` (or Android Keystore).
    - Key-specific base nonce derived via **FNV-1a 64-bit hash** of the asset key, incremented per 16-byte CTR block (`blockOffset`), allowing random byte-range seeking inside `EncryptedFileDataSource`.
- **DLNA / Chromecast (`P7/i`)**:
  - Calls `POST episodes/{id}/cast` with `{ track, url, subtitles }` so AniFam returns CORS-friendly, unsigned cast URLs for TV receivers (`url`, `subtitles`, `expiresAt`).
- **Watch2Gether (`X7/F0`, `O7/d`)**:
  - Synchronized room playback driven by `O7/d` and Tencent LiteAV (`txvodplayer`) for synchronized play/pause/seek events.
- **YouTube Trailers Only**:
  - Bundled `NewPipeExtractor` is used strictly for trailer previews, not episode streams.

---

## 3. Side-by-Side Comparison & Web Browser Integration Constraints

| Dimension | MiruDL (`2.2.1`) | AniFam (`0.2.9`) | Web Integration Solution (`src/`) |
|---|---|---|---|
| **Catalog API** | `anilab2.amdapi.click/api/*` | `app.anifam.net/api/v1/app/*` + 4 failover domains | `MiruDLClient` & `AniFamClient` |
| **Auth / Signing** | Empty-body `POST` to `api.kyotoplayer.com` w/ HMAC-SHA256 + `1500ms` gap | `X-App-Version: 20`, `X-App-Platform: android`, `Bearer` token | Automated in `MiruDLClient` & `AniFamClient` |
| **Browser Header Blockers** | Requires `Referer: https://play.app/`, `UA: Mozilla/5.0` | Requires arbitrary `source.mediaHeaders` (`Referer`, `Origin`, `Cookie`, etc.) | Signed `/api/proxy/hls` + `/api/proxy/segment` (`MediaProxy`) |
| **CORS Restrictions** | Upstream CDN lacks browser CORS headers | Upstream CDN & `.vtt` subtitles often lack CORS headers | `MediaProxy` injects `Access-Control-Allow-Origin: *` & rewrites `.m3u8` |
| **Spoofed-Image `.ts`** | Not used | Yes on Mode 2 (`resolved_hls`) segments (`PNG`/`JPEG`/`GIF8`/`RIFF`/`BMP`) | Streaming `TsUnwrapperTransform` inside `/api/proxy/segment` & `/api/download` |
| **Web Embed Fallback** | N/A | Mode 3 (`embedUrl`) in host-locked WebView | Sandboxed `<iframe>` handled by `AnimeSitePlayer` |
| **Downloading** | 16-thread segment concat to `.mp4` (`HlsDownloader`) | `DownloadGrantDto` + Media3 + `TsUnwrapper` | `/api/download` (server stream) + `WebEpisodeDownloader` (browser progress) |
