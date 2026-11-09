/**
 * Browser Episode Downloader (`WebEpisodeDownloader`)
 *
 * Provides two clean download strategies for website integration:
 *  1. `triggerServerDownload`: Direct streaming download via `/api/download`
 *     (server fetches segments concurrently, strips spoofed AniFam image prefixes if needed,
 *      and streams directly to the browser's native download manager — zero browser RAM usage).
 *  2. `downloadInBrowserWithProgress`: Client-side concurrent M3U8 segment fetcher through
 *     `/api/proxy/*` with live progress, speed (bytes/sec), cancellation (`AbortController`),
 *     and either Blob save or File System Access API streaming (`showSaveFilePicker`).
 */

export class WebEpisodeDownloader {
  constructor(options = {}) {
    this.apiBase = (options.apiBase || '').replace(/\/+$/, '');
  }

  /**
   * Build the direct server-assembled download URL.
   *
   * @param {{
   *   downloadUrl?: string,
   *   provider?: 'mirudl' | 'anifam',
   *   episodeId?: string | number,
   *   lang?: string,
   *   track?: string,
   *   serverId?: string | number,
   *   quality?: string,
   *   title?: string,
   *   concurrency?: number,
   * }} params
   */
  buildServerDownloadUrl(params) {
    if (params.downloadUrl) {
      const url = new URL(params.downloadUrl, window.location.origin);
      if (params.quality) url.searchParams.set('quality', params.quality);
      if (params.title) url.searchParams.set('title', params.title);
      if (params.concurrency) url.searchParams.set('concurrency', String(params.concurrency));
      return this.apiBase ? `${this.apiBase}${url.pathname}${url.search}` : `${url.pathname}${url.search}`;
    }

    const qs = new URLSearchParams();
    for (const key of ['provider', 'episodeId', 'lang', 'track', 'serverId', 'quality', 'title', 'concurrency']) {
      if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
        qs.set(key, String(params[key]));
      }
    }
    return `${this.apiBase}/api/download?${qs.toString()}`;
  }

  /**
   * Trigger a native browser download via `/api/download`.
   */
  triggerServerDownload(params) {
    const href = this.buildServerDownloadUrl(params);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${params.title || 'episode'}.mp4`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return href;
  }

  /**
   * Parse proxied M3U8 text in the browser and download all segments concurrently
   * with live progress & abort support.
   *
   * @param {{
   *   proxyHlsUrl: string,
   *   preferredQuality?: string,
   *   filename?: string,
   *   concurrency?: number,
   *   signal?: AbortSignal,
   *   writableStream?: FileSystemWritableFileStream | null,
   *   onProgress?: (info: { percent: number, completed: number, total: number, bytesDownloaded: number, speedBytesPerSec: number, quality: string }) => void,
   * }} options
   */
  async downloadInBrowserWithProgress(options) {
    const concurrency = Math.max(1, Math.min(12, options.concurrency || 6));
    const signal = options.signal;
    const hlsUrl = options.proxyHlsUrl.startsWith('http')
      ? options.proxyHlsUrl
      : `${this.apiBase}${options.proxyHlsUrl}`;

    const rootRes = await fetch(hlsUrl, { signal });
    if (!rootRes.ok) throw new Error(`Failed loading playlist: HTTP ${rootRes.status}`);
    let playlistText = await rootRes.text();
    let mediaUrl = hlsUrl;
    let selectedQuality = 'Auto';

    if (playlistText.includes('#EXT-X-STREAM-INF')) {
      const chosen = this._pickVariant(playlistText, mediaUrl, options.preferredQuality || '1080p');
      if (chosen) {
        mediaUrl = chosen.url;
        selectedQuality = chosen.quality;
        const subRes = await fetch(mediaUrl, { signal });
        if (!subRes.ok) throw new Error(`Failed loading variant playlist: HTTP ${subRes.status}`);
        playlistText = await subRes.text();
      }
    }

    const { initMapUrl, segments, encrypted } = this._parseMedia(playlistText, mediaUrl);
    if (encrypted) {
      throw new Error('Encrypted HLS streams (#EXT-X-KEY) are not supported');
    }
    if (!segments.length) {
      throw new Error('No HLS segments found');
    }

    const chunks = [];
    let bytesDownloaded = 0;
    let completed = 0;
    const startedAt = performance.now();

    const writable = options.writableStream || null;

    if (initMapUrl) {
      const initBuf = await this._fetchBytesWithRetry(initMapUrl, signal);
      bytesDownloaded += initBuf.byteLength;
      if (writable) await writable.write(initBuf);
      else chunks.push(initBuf);
    }

    const results = new Array(segments.length);
    let nextFetchIdx = 0;
    let nextFlushIdx = 0;

    const report = () => {
      if (!options.onProgress) return;
      const elapsedSec = Math.max(0.05, (performance.now() - startedAt) / 1000);
      options.onProgress({
        percent: Math.floor((completed * 100) / segments.length),
        completed,
        total: segments.length,
        bytesDownloaded,
        speedBytesPerSec: Math.round(bytesDownloaded / elapsedSec),
        quality: selectedQuality,
      });
    };

    const workers = Array.from({ length: Math.min(concurrency, segments.length) }, async () => {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const idx = nextFetchIdx++;
        if (idx >= segments.length) break;
        const buf = await this._fetchBytesWithRetry(segments[idx], signal);
        results[idx] = buf;
        bytesDownloaded += buf.byteLength;
        completed += 1;

        if (writable) {
          while (results[nextFlushIdx]) {
            const b = results[nextFlushIdx];
            results[nextFlushIdx] = null;
            await writable.write(b);
            nextFlushIdx += 1;
          }
        }
        report();
      }
    });

    await Promise.all(workers);

    if (writable) {
      await writable.close();
      return { quality: selectedQuality, bytesDownloaded, segments: segments.length };
    }

    for (const part of results) {
      if (part) chunks.push(part);
    }
    const blob = new Blob(chunks, { type: 'video/mp4' });
    const filename = options.filename || `episode-${selectedQuality}.mp4`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);

    return { quality: selectedQuality, bytesDownloaded, segments: segments.length, blob };
  }

  async _fetchBytesWithRetry(url, signal, retries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, attempt * 400));
        }
      }
    }
    throw lastErr;
  }

  _pickVariant(m3u8Text, baseUrl, preferredQuality) {
    const lines = m3u8Text.split(/\r?\n/);
    const variants = [];
    let pending = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        pending = line;
      } else if (pending && !line.startsWith('#')) {
        const resMatch = /RESOLUTION=\d+x(\d+)/i.exec(pending);
        const height = resMatch ? Number(resMatch[1]) : 0;
        variants.push({
          height,
          quality: height ? `${height}p` : 'Auto',
          url: new URL(line, baseUrl).toString(),
        });
        pending = null;
      }
    }
    if (!variants.length) return null;
    const pref = String(preferredQuality).toLowerCase();
    if (pref === 'highest' || pref === 'best') {
      return [...variants].sort((a, b) => b.height - a.height)[0];
    }
    if (pref === 'lowest') {
      return [...variants].sort((a, b) => a.height - b.height)[0];
    }
    const target = Number.parseInt(pref, 10);
    if (Number.isFinite(target)) {
      const exact = variants.find((v) => v.height === target);
      if (exact) return exact;
      const below = variants.filter((v) => v.height > 0 && v.height <= target).sort((a, b) => b.height - a.height);
      if (below.length) return below[0];
    }
    return [...variants].sort((a, b) => b.height - a.height)[0];
  }

  _parseMedia(m3u8Text, baseUrl) {
    const lines = m3u8Text.split(/\r?\n/);
    const segments = [];
    let initMapUrl = null;
    let encrypted = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/i.test(line)) {
        encrypted = true;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const m = /URI="([^"]+)"/i.exec(line);
        if (m) initMapUrl = new URL(m[1], baseUrl).toString();
      } else if (!line.startsWith('#')) {
        segments.push(new URL(line, baseUrl).toString());
      }
    }
    return { initMapUrl, segments, encrypted };
  }
}
