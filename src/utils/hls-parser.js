/**
 * HLS Master & Media Playlist Parser, Quality Selector, and Proxy Rewriter.
 *
 * Combines:
 *  - MiruDL's `HlsDownloader.qualities` / `variantScore` / `pickBestVariant`
 *  - AniFam's `F7/x` height-based resolution matcher (`RESOLUTION=\d+x(\d+)`)
 *  - Full M3U8 URI rewriting for web CORS/header proxying (`#EXT-X-MAP`, `#EXT-X-KEY`,
 *    `#EXT-X-MEDIA`, `#EXT-X-STREAM-INF`, and media segments).
 */

/**
 * Resolve a potentially relative URL against a playlist base URL.
 * Mirrors MiruDL's `HlsDownloader.resolve` and `MiruClient.resolveUrl`.
 *
 * @param {string} target
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveHlsUrl(target, baseUrl) {
  const trimmed = String(target || '').trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return new URL(trimmed, baseUrl).toString();
}

/**
 * Parse comma-separated M3U8 attribute list (e.g. BANDWIDTH=123,RESOLUTION=1920x1080,URI="...").
 *
 * @param {string} line
 * @returns {Record<string, string>}
 */
export function parseAttributes(line) {
  const colonIdx = line.indexOf(':');
  const raw = colonIdx >= 0 ? line.slice(colonIdx + 1) : line;
  const attrs = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1].toUpperCase();
    const val = match[3] !== undefined ? match[3] : match[2];
    attrs[key] = val.trim();
  }
  return attrs;
}

/**
 * Infer a human-readable quality label (`1080p`, `720p`, `480p`, `360p`, `Auto`)
 * matching `HlsDownloader.labelFor` in MiruDL.
 *
 * @param {string} streamInfLine
 * @returns {{ label: string, width: number|null, height: number|null, bandwidth: number }}
 */
export function parseStreamInfMeta(streamInfLine) {
  const attrs = parseAttributes(streamInfLine);
  let width = null;
  let height = null;
  if (attrs.RESOLUTION) {
    const m = /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION);
    if (m) {
      width = Number(m[1]);
      height = Number(m[2]);
    }
  }
  const bandwidth = attrs.BANDWIDTH ? Number.parseInt(attrs.BANDWIDTH, 10) || 0 : 0;

  let label = 'Auto';
  if (height) {
    label = `${height}p`;
  } else if (bandwidth >= 4_500_000) {
    label = '1080p';
  } else if (bandwidth >= 2_200_000) {
    label = '720p';
  } else if (bandwidth >= 1_000_000) {
    label = '480p';
  } else if (bandwidth > 0) {
    label = '360p';
  }

  return {
    label,
    width,
    height,
    bandwidth,
    resolution: attrs.RESOLUTION || null,
    codecs: attrs.CODECS || null,
    audioGroup: attrs.AUDIO || null,
    raw: streamInfLine,
  };
}

/**
 * MiruDL's `HlsDownloader.variantScore(String)` scoring helper.
 * Accepts `"1920x1080"`, `"1080p"`, or a variant object.
 *
 * @param {string | { resolution?: string|null, width?: number|null, height?: number|null, label?: string, quality?: string, bandwidth?: number }} input
 * @returns {number}
 */
export function variantScore(input) {
  if (!input) return 0;
  if (typeof input === 'object') {
    if (input.width && input.height) return input.width * input.height;
    if (input.height) return input.height;
    const str = input.resolution || input.quality || input.label || '';
    const s = variantScore(str);
    return s > 0 ? s : (input.bandwidth || 0);
  }
  const trimmed = String(input).trim();
  const xIdx = trimmed.indexOf('x');
  if (xIdx > 0) {
    const w = Number.parseInt(trimmed.slice(0, xIdx).trim(), 10);
    const h = Number.parseInt(trimmed.slice(xIdx + 1).trim().split(/[^0-9]/)[0], 10);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      return w * h;
    }
  }
  const digits = trimmed.split(/[^0-9]/)[0];
  if (!digits) return 0;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse an HLS Master Playlist (`#EXT-X-STREAM-INF` + `#EXT-X-MEDIA`).
 *
 * @param {string} m3u8Text
 * @param {string} baseUrl
 */
export function parseMasterPlaylist(m3u8Text, baseUrl) {
  const lines = String(m3u8Text || '').split(/\r?\n/);
  const variants = [];
  const mediaTracks = [];
  let pendingStreamInf = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line);
      mediaTracks.push({
        type: attrs.TYPE || '',
        groupId: attrs['GROUP-ID'] || '',
        name: attrs.NAME || '',
        language: attrs.LANGUAGE || '',
        default: attrs.DEFAULT === 'YES',
        autoselect: attrs.AUTOSELECT === 'YES',
        uri: attrs.URI ? resolveHlsUrl(attrs.URI, baseUrl) : null,
        raw: line,
      });
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      pendingStreamInf = line;
      continue;
    }

    if (pendingStreamInf && !line.startsWith('#')) {
      const meta = parseStreamInfMeta(pendingStreamInf);
      variants.push({
        ...meta,
        quality: meta.label,
        url: resolveHlsUrl(line, baseUrl),
        score: variantScore(meta),
      });
      pendingStreamInf = null;
    }
  }

  return {
    isMaster: variants.length > 0,
    variants,
    mediaTracks,
  };
}

/**
 * Parse an HLS Media Playlist (segments, `#EXT-X-MAP`, `#EXT-X-KEY`, durations).
 *
 * @param {string} m3u8Text
 * @param {string} baseUrl
 */
export function parseMediaPlaylist(m3u8Text, baseUrl) {
  const lines = String(m3u8Text || '').split(/\r?\n/);
  const segments = [];
  const keys = [];
  let initMapUrl = null;
  let currentDuration = null;
  let currentByteRange = null;
  let targetDuration = null;
  let mediaSequence = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || null;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line);
      keys.push({
        method: attrs.METHOD || 'NONE',
        uri: attrs.URI ? resolveHlsUrl(attrs.URI, baseUrl) : null,
        iv: attrs.IV || null,
        raw: line,
      });
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line);
      if (attrs.URI) {
        initMapUrl = resolveHlsUrl(attrs.URI, baseUrl);
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const val = line.slice('#EXTINF:'.length).split(',')[0];
      currentDuration = Number.parseFloat(val) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      currentByteRange = line.slice('#EXT-X-BYTERANGE:'.length).trim();
      continue;
    }

    if (!line.startsWith('#')) {
      segments.push({
        index: segments.length,
        sequence: mediaSequence + segments.length,
        url: resolveHlsUrl(line, baseUrl),
        duration: currentDuration,
        byteRange: currentByteRange,
      });
      currentDuration = null;
      currentByteRange = null;
    }
  }

  const encrypted = keys.some((k) => k.method && k.method.toUpperCase() !== 'NONE');

  return {
    encrypted,
    keys,
    initMapUrl,
    targetDuration,
    mediaSequence,
    segments,
  };
}

/**
 * Pick the highest-resolution variant (matches `HlsDownloader.pickBestVariant` in MiruDL).
 *
 * @template {{ score?: number, width?: number|null, height?: number|null, quality?: string, label?: string, bandwidth?: number }} T
 * @param {T[]} variants
 * @returns {T|null}
 */
export function pickBestVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  let best = variants[0];
  let bestScore = variantScore(best);
  for (let i = 1; i < variants.length; i++) {
    const score = variantScore(variants[i]);
    if (score > bestScore) {
      best = variants[i];
      bestScore = score;
    }
  }
  return best;
}

/**
 * Select a variant matching a preferred quality (`"1080p"`, `"720p"`, `"480p"`, `"360p"`,
 * `"highest"`, `"lowest"`, or `"auto"`).
 * Fixes MiruDL's `DownloadService.runSingleJob` behavior where preferred quality was ignored.
 *
 * Selection logic:
 *  - `"highest"` / `"best"`: `pickBestVariant(variants)`
 *  - `"lowest"`: lowest positive score variant
 *  - Numeric target (e.g. `"720p"` or `"720"`):
 *      1) exact height match (`height === target`), or label contains target
 *      2) highest height `<= target` (matches AniFam's `F7/x` quality cap behavior)
 *      3) lowest height `> target` if everything exceeds target
 *      4) fallback to `pickBestVariant`
 *
 * @template {{ score?: number, width?: number|null, height?: number|null, quality?: string, label?: string, bandwidth?: number, url: string }} T
 * @param {T[]} variants
 * @param {string} [preferredQuality='highest']
 * @returns {T|null}
 */
export function pickVariantByQuality(variants, preferredQuality = 'highest') {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const pref = String(preferredQuality || 'highest').trim().toLowerCase();

  if (pref === 'highest' || pref === 'best' || pref === 'max') {
    return pickBestVariant(variants);
  }

  if (pref === 'lowest' || pref === 'min') {
    return [...variants].sort((a, b) => variantScore(a) - variantScore(b))[0];
  }

  const targetMatch = /(\d{3,4})/.exec(pref);
  if (!targetMatch) {
    return pickBestVariant(variants);
  }
  const targetHeight = Number.parseInt(targetMatch[1], 10);

  // 1. Exact height or label match
  const exact = variants.find((v) => {
    if (v.height === targetHeight) return true;
    const lbl = String(v.quality || v.label || '').toLowerCase();
    return lbl.includes(String(targetHeight));
  });
  if (exact) return exact;

  // 2. Highest height <= targetHeight (AniFam F7/x logic)
  const withHeight = variants.filter((v) => Number.isFinite(v.height) && v.height > 0);
  if (withHeight.length > 0) {
    const atOrBelow = withHeight.filter((v) => v.height <= targetHeight);
    if (atOrBelow.length > 0) {
      return atOrBelow.sort((a, b) => b.height - a.height)[0];
    }
    return withHeight.sort((a, b) => a.height - b.height)[0];
  }

  return pickBestVariant(variants);
}

/**
 * Rewrite an M3U8 playlist (Master or Media) so all nested playlists, init maps,
 * encryption keys, alternate audio/subtitle tracks, and media segments route
 * through a web proxy endpoint.
 *
 * @param {string} m3u8Text
 * @param {string} baseUrl
 * @param {{
 *   rewritePlaylistUrl: (absoluteUrl: string) => string,
 *   rewriteSegmentUrl: (absoluteUrl: string) => string,
 *   rewriteKeyUrl?: (absoluteUrl: string) => string,
 * }} rewriters
 * @returns {string}
 */
export function rewriteHlsPlaylist(m3u8Text, baseUrl, rewriters) {
  const { rewritePlaylistUrl, rewriteSegmentUrl, rewriteKeyUrl = rewriteSegmentUrl } = rewriters;
  const lines = String(m3u8Text || '').split(/\r?\n/);
  const out = [];
  let expectVariantUrl = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      out.push(rawLine);
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      expectVariantUrl = true;
      out.push(line);
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const rewritten = line.replace(/URI="([^"]+)"/i, (_, uri) => {
        const abs = resolveHlsUrl(uri, baseUrl);
        return `URI="${rewritePlaylistUrl(abs)}"`;
      });
      out.push(rewritten);
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const rewritten = line.replace(/URI="([^"]+)"/i, (_, uri) => {
        const abs = resolveHlsUrl(uri, baseUrl);
        return `URI="${rewriteSegmentUrl(abs)}"`;
      });
      out.push(rewritten);
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const rewritten = line.replace(/URI="([^"]+)"/i, (_, uri) => {
        const abs = resolveHlsUrl(uri, baseUrl);
        return `URI="${rewriteKeyUrl(abs)}"`;
      });
      out.push(rewritten);
      continue;
    }

    if (line.startsWith('#')) {
      out.push(line);
      continue;
    }

    const abs = resolveHlsUrl(line, baseUrl);
    if (expectVariantUrl) {
      expectVariantUrl = false;
      out.push(rewritePlaylistUrl(abs));
    } else {
      out.push(rewriteSegmentUrl(abs));
    }
  }

  return out.join('\n');
}
