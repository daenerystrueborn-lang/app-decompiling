/**
 * AniFam API Client (Multi-Domain Failover + Auth/Platform Headers)
 *
 * Extracted from `Anifam-App-Latest-v0.2.9.apk` (`v7/c`, `v7/h`, `v7/j`, `h8/a`, `O7/d`).
 *
 * Includes:
 *  - Required platform headers (`Accept: application/json`, `X-App-Version: 20`, `X-App-Platform: android`,
 *    optional `Authorization: Bearer <token>`)
 *  - Domain failover across `anifam.net`, `anifam.buzz`, `anifam.top`, `anifam.cfd` on `GET`/`HEAD`
 *    network errors, `5xx`, or `429` (respecting `Retry-After <= 20s` and `h8/a` up to 3 tries)
 *  - Playback session (`POST episodes/{id}/play`), Server resolution (`POST episodes/{id}/resolve`
 *    cached per `(episodeId, serverId, track)`), Download grants (`POST episodes/{id}/download`),
 *    and Cast URLs (`POST episodes/{id}/cast`).
 */

export const ANIFAM_CONSTANTS = Object.freeze({
  PRIMARY_API_BASE: 'https://app.anifam.net/api/v1/app/',
  FAILOVER_DOMAINS: Object.freeze([
    'https://anifam.net',
    'https://anifam.buzz',
    'https://anifam.top',
    'https://anifam.cfd',
  ]),
  APP_VERSION: '20',
  APP_PLATFORM: 'android',
  DEFAULT_TRACK: 'sub',
  MEGAPLAY_HOST: 'megaplay.buzz',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize & deduplicate HTTPS domain base URLs (`v7/e.a`).
 *
 * @param {string[]} domains
 * @returns {string[]}
 */
export function normalizeFailoverDomains(domains) {
  const seenHosts = new Set();
  const out = [];
  for (const raw of domains || []) {
    try {
      const u = new URL(String(raw).trim().replace(/\/+$/, '') + '/');
      if (u.protocol !== 'https:') continue;
      if (u.hostname === 'app.anifam.net') continue;
      if (!u.hostname.includes('.') || seenHosts.has(u.hostname)) continue;
      seenHosts.add(u.hostname);
      out.push(`${u.protocol}//${u.host}`);
    } catch {
      // ignore invalid URL
    }
  }
  return out;
}

export class AniFamApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {any} [body]
   */
  constructor(status, message, body = null) {
    super(message);
    this.name = 'AniFamApiError';
    this.status = status;
    this.body = body;
  }

  /** Matches `m7.b.d()` — HTTP 403 triggers the login/entitlement wall in AniFam. */
  isEntitlementWall() {
    return this.status === 403;
  }
}

export class AniFamClient {
  /**
   * @param {{
   *   primaryApiBase?: string,
   *   failoverDomains?: string[],
   *   bearerToken?: string | null,
   *   appVersion?: string,
   *   appPlatform?: string,
   *   fetchImpl?: typeof fetch,
   *   timeoutMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.primaryApiBase = options.primaryApiBase || ANIFAM_CONSTANTS.PRIMARY_API_BASE;
    const rawDomains = options.failoverDomains?.length
      ? options.failoverDomains
      : [...ANIFAM_CONSTANTS.FAILOVER_DOMAINS];
    const normalized = normalizeFailoverDomains(rawDomains);
    // Keep custom primary origin if user pointed at a local mock or custom host
    this.failoverOrigins = normalized.length ? normalized : [new URL(this.primaryApiBase).origin];
    this.activeOrigin = this.failoverOrigins[0];

    this.bearerToken = options.bearerToken || null;
    this.appVersion = String(options.appVersion || ANIFAM_CONSTANTS.APP_VERSION);
    this.appPlatform = String(options.appPlatform || ANIFAM_CONSTANTS.APP_PLATFORM);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;

    // Matches `O7/d.c` cache per `${episodeId}:${serverId}:${track}`
    this._resolveCache = new Map();
  }

  setBearerToken(token) {
    this.bearerToken = token || null;
  }

  /**
   * Resolve relative URLs (e.g., WebView `embedUrl`) using the active domain (`v7/h.a`).
   *
   * @param {string|null|undefined} url
   * @returns {string|null}
   */
  resolveRelativeDomainUrl(url) {
    if (!url || !String(url).trim()) return null;
    const trimmed = String(url).trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return `${this.activeOrigin.replace(/\/+$/, '')}${trimmed}`;
    }
    return trimmed;
  }

  _orderedOrigins(useFailover = true) {
    const primaryOrigin = new URL(this.primaryApiBase).origin;
    if (!useFailover) {
      return [primaryOrigin];
    }
    const others = this.failoverOrigins.filter(
      (o) => o !== this.activeOrigin && o !== primaryOrigin
    );
    const list = [primaryOrigin];
    if (this.activeOrigin && !list.includes(this.activeOrigin)) {
      list.push(this.activeOrigin);
    }
    for (const o of others) {
      if (!list.includes(o)) list.push(o);
    }
    return list;
  }

  async _fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform an API request mimicking `h8/a` (headers + multi-domain failover + Retry-After).
   *
   * @param {string} path Relative to `/api/v1/app/`
   * @param {{ method?: string, body?: any, headers?: Record<string, string>, token?: string|null }} [opts]
   * @returns {Promise<any>}
   */
  async request(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const cleanPath = String(path).replace(/^\/+/, '');
    const primaryUrl = new URL(this.primaryApiBase);
    const apiPathPrefix = primaryUrl.pathname.replace(/\/?$/, '/');
    const isIdempotent = method === 'GET' || method === 'HEAD';

    const baseHost = primaryUrl.hostname;
    const useMultiDomain = baseHost === 'app.anifam.net';
    const candidateOrigins = useMultiDomain ? this._orderedOrigins(true) : [primaryUrl.origin];

    const baseHeaders = {
      Accept: 'application/json',
      'X-App-Version': this.appVersion,
      'X-App-Platform': this.appPlatform,
      ...(opts.headers || {}),
    };
    const token = opts.token !== undefined ? opts.token : this.bearerToken;
    let serializedBody;
    if (opts.body !== undefined) {
      serializedBody = JSON.stringify(opts.body);
      baseHeaders['Content-Type'] = 'application/json';
    }

    let lastError = null;
    let attempts = 0;

    for (let i = 0; i < candidateOrigins.length && attempts < 4; i++) {
      const origin = candidateOrigins[i];
      const originHost = new URL(origin).hostname;
      const url = `${origin}${apiPathPrefix}${cleanPath}`;
      attempts++;

      const headers = { ...baseHeaders };
      // Only attach Bearer auth to the primary API host (`app.anifam.net`), or custom non-anifam base
      if (token && !headers.Authorization && (!useMultiDomain || originHost === baseHost)) {
        headers.Authorization = `Bearer ${token}`;
      }

      try {
        const res = await this._fetchWithTimeout(url, {
          method,
          headers,
          body: serializedBody,
        });

        const text = await res.text();
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }

        if (res.status === 429) {
          const retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
          const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000;
          if (attempts < 4 && delayMs <= 20_000) {
            await sleep(delayMs);
            i -= 1; // retry same origin after Retry-After
            continue;
          }
          throw new AniFamApiError(res.status, `AniFam HTTP 429 on ${cleanPath}`, parsed);
        }

        if (res.status >= 500 && res.status < 600 && isIdempotent && i < candidateOrigins.length - 1) {
          lastError = new AniFamApiError(res.status, `AniFam HTTP ${res.status} on ${url}`, parsed);
          continue;
        }

        if (!res.ok) {
          throw new AniFamApiError(
            res.status,
            parsed?.message || `AniFam HTTP ${res.status} on ${cleanPath}`,
            parsed
          );
        }

        const ct = res.headers.get('content-type') || '';
        if (res.status === 204 || res.status === 304 || ct.toLowerCase().includes('json')) {
          this.activeOrigin = origin;
          return parsed;
        }

        // Non-JSON body (e.g. ISP block page) triggers domain failover on idempotent methods
        if (isIdempotent && i < candidateOrigins.length - 1) {
          lastError = new Error(`Unexpected non-JSON response (${ct}) from ${url}`);
          continue;
        }
        return parsed;
      } catch (err) {
        if (err instanceof AniFamApiError && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastError = err;
        if (!isIdempotent && i >= candidateOrigins.length - 1) {
          throw err;
        }
      }
    }

    throw lastError || new Error(`AniFam request failed for ${cleanPath}`);
  }

  getConfig() {
    return this.request('config');
  }

  getHome() {
    return this.request('home');
  }

  search(query, page = 1) {
    return this.request(`search?q=${encodeURIComponent(query)}&page=${encodeURIComponent(page)}`);
  }

  browse(params = {}) {
    const qs = new URLSearchParams();
    for (const key of ['genre', 'type', 'status', 'season', 'year', 'sort', 'page']) {
      if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
        qs.set(key, String(params[key]));
      }
    }
    return this.request(`browse?${qs.toString()}`);
  }

  getAnime(animeId) {
    return this.request(`anime/${encodeURIComponent(animeId)}`);
  }

  getEpisodes(animeId) {
    return this.request(`anime/${encodeURIComponent(animeId)}/episodes`);
  }

  /**
   * `POST episodes/{id}/play` (`Lv7/c;->V`) with `{ track }` (`PlayRequest`).
   *
   * @param {string|number} episodeId
   * @param {string} [track='sub']
   */
  getPlayback(episodeId, track = ANIFAM_CONSTANTS.DEFAULT_TRACK) {
    return this.request(`episodes/${encodeURIComponent(episodeId)}/play`, {
      method: 'POST',
      body: { track },
    });
  }

  /**
   * `POST episodes/{id}/resolve` (`Lv7/c;->G0`) with `{ serverId, track }` (`ResolveRequest`).
   * Cached per `(episodeId, serverId, track)` like `O7/d.a()` (except `403` errors).
   *
   * @param {string|number} episodeId
   * @param {string|number} serverId
   * @param {string} [track='sub']
   */
  async resolveIframeSource(episodeId, serverId, track = ANIFAM_CONSTANTS.DEFAULT_TRACK) {
    const key = `${episodeId}:${serverId}:${track}`;
    if (this._resolveCache.has(key)) {
      return this._resolveCache.get(key);
    }
    const resolved = await this.request(`episodes/${encodeURIComponent(episodeId)}/resolve`, {
      method: 'POST',
      body: { serverId: Number(serverId), track },
    });
    this._resolveCache.set(key, resolved);
    return resolved;
  }

  /**
   * `POST episodes/{id}/download` (`Lv7/c;->N0`) with `{ track, quality }` (`DownloadRequestBody`).
   * Extracts or synthesizes a `PlaybackSourceDto` matching `DownloadGrantDto.a()`.
   *
   * @param {string|number} episodeId
   * @param {{ track?: string, quality?: string }} [options]
   */
  async requestDownloadGrant(episodeId, options = {}) {
    const track = options.track || ANIFAM_CONSTANTS.DEFAULT_TRACK;
    const quality = options.quality || '1080p';
    const grant = await this.request(`episodes/${encodeURIComponent(episodeId)}/download`, {
      method: 'POST',
      body: { track, quality },
    });
    const source = extractSourceFromDownloadGrant(grant);
    return { grant, source };
  }

  /**
   * `POST episodes/{id}/cast` (`Lv7/c;->F`) with `{ track, url, subtitles }`.
   *
   * @param {string|number} episodeId
   * @param {{ track?: string, url: string, subtitles?: string[] }} body
   */
  requestCastUrls(episodeId, body) {
    return this.request(`episodes/${encodeURIComponent(episodeId)}/cast`, {
      method: 'POST',
      body: {
        track: body.track || ANIFAM_CONSTANTS.DEFAULT_TRACK,
        url: body.url,
        subtitles: body.subtitles || [],
      },
    });
  }
}

/**
 * Port of `DownloadGrantDto.a()` (`net.anifam.app.core.network.dto.DownloadGrantDto`):
 * picks the first `kind === "hls"` item from `grant.sources`, or builds one from top-level fields.
 *
 * @param {any} grant
 */
export function extractSourceFromDownloadGrant(grant) {
  if (!grant) return null;
  if (Array.isArray(grant.sources)) {
    const hlsSource = grant.sources.find((s) => s && s.kind === 'hls');
    if (hlsSource) return hlsSource;
  }
  if (!grant.url) return null;
  return {
    kind: grant.kind || 'hls',
    server: grant.server || '',
    serverId: null,
    url: grant.url,
    mirrors: grant.mirrors || [],
    mediaHeaders: grant.mediaHeaders || {},
    qualities: grant.qualities || [],
    subtitles: grant.subtitles || [],
    spriteVtt: grant.spriteVtt || null,
    thumb: grant.thumb || null,
    skip: grant.skip || null,
    duration: grant.duration ?? null,
    resolvable: null,
    embedUrl: null,
    backup: Boolean(grant.backup),
  };
}
