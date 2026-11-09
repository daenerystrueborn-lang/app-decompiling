/**
 * Secure Web Media Proxy & Playlist Rewriter
 *
 * Solves browser integration blockers for both MiruDL and AniFam:
 *  1. Injects forbidden/custom HTTP headers (`Referer`, `User-Agent`, `Origin`, AniFam `mediaHeaders`)
 *  2. Bypasses upstream CORS restrictions with clean CORS headers for `<video>` / `hls.js` / `fetch`
 *  3. Recursively rewrites `.m3u8` master/media playlists (`#EXT-X-MAP`, `#EXT-X-KEY`, `#EXT-X-MEDIA`,
 *     variant URLs, and segments)
 *  4. Unwraps spoofed image headers (`PNG`, `JPEG`, `GIF8`, `RIFF`, `BMP` -> `0x47`x3 @ 188B)
 *     in real time on AniFam resolved iframe streams via `TsUnwrapperTransform`
 *  5. Signs proxy target descriptors with HMAC-SHA256 tokens so the endpoint cannot be abused as an open SSRF proxy.
 */

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { rewriteHlsPlaylist } from '../utils/hls-parser.js';
import { TsUnwrapperTransform } from '../utils/ts-unwrapper.js';
import { rewriteAssetOriginForMirror } from '../providers/anifam-playback.js';

const DEFAULT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class MediaProxy {
  /**
   * @param {{
   *   secret?: string,
   *   allowUnsignedDev?: boolean,
   *   tokenTtlMs?: number,
   *   fetchImpl?: typeof fetch,
   * }} [options]
   */
  constructor(options = {}) {
    this.secret = options.secret || crypto.randomBytes(32).toString('hex');
    this.allowUnsignedDev = Boolean(options.allowUnsignedDev);
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  /**
   * Create an HMAC-SHA256 signed token encapsulating target URL, headers, mirrors, and unwrapTs flag.
   *
   * @param {{
   *   url: string,
   *   headers?: Record<string, string>,
   *   mirrors?: string[],
   *   primaryOriginUrl?: string,
   *   unwrapTs?: boolean,
   * }} payload
   * @returns {string}
   */
  signTarget(payload) {
    const body = {
      u: payload.url,
      h: payload.headers || {},
      m: payload.mirrors || [],
      p: payload.primaryOriginUrl || payload.url,
      w: Boolean(payload.unwrapTs),
      exp: Date.now() + this.tokenTtlMs,
    };
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.secret)
      .update(encoded, 'utf8')
      .digest('base64url');
    return `${encoded}.${sig}`;
  }

  /**
   * Verify and decode a signed proxy token.
   *
   * @param {string} token
   */
  verifyToken(token) {
    if (!token || !String(token).includes('.')) {
      throw new Error('Missing or malformed proxy token');
    }
    const [encoded, sig] = String(token).split('.', 2);
    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(encoded, 'utf8')
      .digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('Invalid proxy token signature');
    }
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) {
      throw new Error('Expired proxy token');
    }
    return {
      url: data.u,
      headers: data.h || {},
      mirrors: data.m || [],
      primaryOriginUrl: data.p || data.u,
      unwrapTs: Boolean(data.w),
    };
  }

  /**
   * Build signed proxy URL for HLS playlists (`basePath = "/api/proxy"`).
   */
  buildHlsProxyUrl(basePath, target) {
    const token = this.signTarget(target);
    return `${basePath}/hls?token=${encodeURIComponent(token)}`;
  }

  buildSegmentProxyUrl(basePath, target) {
    const token = this.signTarget(target);
    return `${basePath}/segment?token=${encodeURIComponent(token)}`;
  }

  buildSubtitleProxyUrl(basePath, target) {
    const token = this.signTarget(target);
    return `${basePath}/subtitle?token=${encodeURIComponent(token)}`;
  }

  _resolveRequestTarget(searchParams) {
    const token = searchParams.get('token');
    if (token) {
      return this.verifyToken(token);
    }
    if (this.allowUnsignedDev) {
      const url = searchParams.get('url');
      if (!url) throw new Error('Missing url or token parameter');
      let headers = {};
      const rawHeaders = searchParams.get('headers');
      if (rawHeaders) {
        headers = JSON.parse(rawHeaders);
      }
      return {
        url,
        headers,
        mirrors: [],
        primaryOriginUrl: url,
        unwrapTs: searchParams.get('unwrapTs') === '1' || searchParams.get('unwrapTs') === 'true',
      };
    }
    throw new Error('Signed proxy token is required');
  }

  async _fetchUpstreamWithMirrors(target, extraHeaders = {}) {
    const candidates = [target.url];
    for (const m of target.mirrors || []) {
      const rewritten = rewriteAssetOriginForMirror(target.url, target.primaryOriginUrl, m);
      if (rewritten && !candidates.includes(rewritten)) {
        candidates.push(rewritten);
      }
    }

    let lastErr = null;
    for (const url of candidates) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            ...target.headers,
            ...extraHeaders,
          },
        });
        if (!res.ok) {
          lastErr = new Error(`Upstream HTTP ${res.status} for ${url}`);
          continue;
        }
        return { res, resolvedUrl: url };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Upstream fetch failed for ${target.url}`);
  }

  _writeCorsHeaders(res, extra = {}) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, X-Unwrapped-Ts');
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) res.setHeader(k, String(v));
    }
  }

  /**
   * Handle `GET /api/proxy/hls` — fetches `.m3u8`, rewrites child URLs back into signed proxy URLs.
   */
  async handleHlsRequest(req, res, urlObj, proxyBasePath = '/api/proxy') {
    const target = this._resolveRequestTarget(urlObj.searchParams);
    const { res: upstream, resolvedUrl } = await this._fetchUpstreamWithMirrors(target);
    const text = await upstream.text();

    const rewritten = rewriteHlsPlaylist(text, resolvedUrl, {
      rewritePlaylistUrl: (abs) =>
        this.buildHlsProxyUrl(proxyBasePath, {
          url: abs,
          headers: target.headers,
          mirrors: target.mirrors,
          primaryOriginUrl: target.primaryOriginUrl,
          unwrapTs: target.unwrapTs,
        }),
      rewriteSegmentUrl: (abs) =>
        this.buildSegmentProxyUrl(proxyBasePath, {
          url: abs,
          headers: target.headers,
          mirrors: target.mirrors,
          primaryOriginUrl: target.primaryOriginUrl,
          unwrapTs: target.unwrapTs,
        }),
    });

    this._writeCorsHeaders(res, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.statusCode = 200;
    res.end(rewritten);
  }

  /**
   * Handle `GET /api/proxy/segment` — streams `.ts` / `.m4s` / `.mp4` / `.key` with optional
   * real-time spoofed image-header stripping (`TsUnwrapperTransform`).
   */
  async handleSegmentRequest(req, res, urlObj) {
    const target = this._resolveRequestTarget(urlObj.searchParams);
    const extraHeaders = {};
    if (!target.unwrapTs && req.headers.range) {
      extraHeaders.Range = req.headers.range;
    }

    const { res: upstream } = await this._fetchUpstreamWithMirrors(target, extraHeaders);
    const contentType = upstream.headers.get('content-type') || 'video/mp2t';
    const contentLength = upstream.headers.get('content-length');

    this._writeCorsHeaders(res, {
      'Content-Type': target.unwrapTs && contentType.startsWith('image/') ? 'video/mp2t' : contentType,
      'Cache-Control': 'public, max-age=300',
      'X-Unwrapped-Ts': target.unwrapTs ? '1' : '0',
    });
    if (!target.unwrapTs && contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    res.statusCode = !target.unwrapTs && upstream.status === 206 ? 206 : 200;
    const contentRange = upstream.headers.get('content-range');
    if (!target.unwrapTs && contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    const bodyStream = upstream.body ? Readable.fromWeb(upstream.body) : Readable.from(Buffer.alloc(0));
    if (target.unwrapTs) {
      const unwrapper = new TsUnwrapperTransform({ enabled: true });
      await pipeline(bodyStream, unwrapper, res);
    } else {
      await pipeline(bodyStream, res);
    }
  }

  /**
   * Handle `GET /api/proxy/subtitle` — proxies WebVTT / SRT subtitle files with CORS headers.
   */
  async handleSubtitleRequest(_req, res, urlObj) {
    const target = this._resolveRequestTarget(urlObj.searchParams);
    const { res: upstream } = await this._fetchUpstreamWithMirrors(target);
    const text = await upstream.text();

    this._writeCorsHeaders(res, {
      'Content-Type': upstream.headers.get('content-type') || 'text/vtt; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.statusCode = 200;
    res.end(text);
  }
}
