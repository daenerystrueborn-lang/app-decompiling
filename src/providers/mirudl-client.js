/**
 * MiruDL Provider Client (AniLab Catalog + Kyoto Player Streaming API)
 *
 * Extracted from `MiruDL-2.2.1.apk` (`msr.mirudl.app.MiruClient` & `AniLabKyotoSource`).
 * Includes:
 *  - XOR-90 `BASE` decoder (`"https://anidb.app"`)
 *  - AniLab catalog client (`/home`, `/categories`, `/category`, `/search`, `/post` + title enrichment)
 *  - Kyoto Player HMAC-SHA256 request signer (`X-Kyoto-Ts`, `X-Kyoto-Nonce`, `X-Kyoto-Sig`, `X-Kyoto-Cert`)
 *  - Serialized `1500 ms` request pacing queue + `401`/`429` retry (`2000 ms`, `5000 ms`)
 *  - Quality extraction + quality-aware stream resolution (fixes `DownloadService.runSingleJob`'s bug
 *    where `preferred_quality` was overwritten by `pickBestVariant`).
 */

import crypto from 'node:crypto';
import {
  parseMasterPlaylist,
  pickBestVariant,
  pickVariantByQuality,
} from '../utils/hls-parser.js';

export const MIRUDL_CONSTANTS = Object.freeze({
  ANILAB_API: 'https://anilab2.amdapi.click/api',
  KYOTO_API: 'https://api.kyotoplayer.com',
  KYOTO_APP_ID: 'com.kyotoplayer',
  KYOTO_APP_VERSION: '132',
  KYOTO_CERT: '482a900b2906766b2e8d3cf19fcf6d06d0b6c9569cb6305c9c43200a8e20979e',
  KYOTO_KEY_RAW: 'bcfb0102a27d4623de59016fcd8a511ff459d73f1671c2d2d7f1d2115e043308',
  KYOTO_MIN_GAP_MS: 1500,
  KYOTO_RETRY_DELAYS_MS: Object.freeze([2000, 5000]),
  ANILAB_UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  HLS_UA: 'Mozilla/5.0',
  HLS_REFERER: 'https://play.app/',
  BASE_XOR_KEY: 90,
  BASE_XOR_BYTES: Object.freeze([
    50, 46, 46, 42, 41, 96, 117, 117, 59, 52, 51, 62, 56, 116, 59, 42, 42,
  ]),
});

const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

/**
 * Decode MiruDL's XOR-90 `BASE` URL (`"https://anidb.app"`).
 *
 * @returns {string}
 */
export function decodeMiruBaseUrl() {
  const buf = Buffer.from(MIRUDL_CONSTANTS.BASE_XOR_BYTES.map((b) => b ^ MIRUDL_CONSTANTS.BASE_XOR_KEY));
  return buf.toString('utf8');
}

/**
 * Derive Kyoto Player's inner HMAC-SHA256 signing key (`MiruClient.kyotoInnerKey()`).
 *
 * @param {string} [rawKeyHex]
 * @param {string} [certHex]
 * @returns {Buffer}
 */
export function deriveKyotoInnerKey(
  rawKeyHex = MIRUDL_CONSTANTS.KYOTO_KEY_RAW,
  certHex = MIRUDL_CONSTANTS.KYOTO_CERT
) {
  const raw = Buffer.from(rawKeyHex, 'hex');
  const xorKey = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    xorKey[i] = raw[i] ^ (((i * 73) + 41) & 0xff);
  }
  const cert = Buffer.from(certHex, 'hex');
  return crypto.createHmac('sha256', xorKey).update(cert).digest();
}

/**
 * Build Kyoto signed headers for an empty-body `POST` request (`MiruClient.kyotoPost`).
 *
 * @param {string} pathWithQuery
 * @param {{
 *   innerKey?: Buffer,
 *   timestampSec?: number,
 *   nonce?: string,
 *   appId?: string,
 *   appVersion?: string,
 *   cert?: string,
 *   osVersion?: string,
 *   deviceModel?: string,
 * }} [opts]
 * @returns {{ headers: Record<string, string>, canonical: string, signature: string }}
 */
export function signKyotoRequest(pathWithQuery, opts = {}) {
  const qIdx = pathWithQuery.indexOf('?');
  const pathOnly = qIdx >= 0 ? pathWithQuery.slice(0, qIdx) : pathWithQuery;
  const ts = opts.timestampSec ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? crypto.randomBytes(16).toString('base64url');
  const appId = opts.appId ?? MIRUDL_CONSTANTS.KYOTO_APP_ID;
  const appVersion = opts.appVersion ?? MIRUDL_CONSTANTS.KYOTO_APP_VERSION;
  const cert = opts.cert ?? MIRUDL_CONSTANTS.KYOTO_CERT;
  const innerKey = opts.innerKey ?? deriveKyotoInnerKey();

  const canonical = `POST\n${pathOnly}\n${EMPTY_BODY_SHA256}\n${ts}\n${nonce}\n${appVersion}`;
  const signature = crypto
    .createHmac('sha256', innerKey)
    .update(canonical, 'utf8')
    .digest('hex');

  return {
    canonical,
    signature,
    headers: {
      Accept: 'application/json',
      'os-version': String(opts.osVersion ?? '34'),
      'app-id': appId,
      'app-version': appVersion,
      'device-model': opts.deviceModel ?? 'Android',
      'X-Kyoto-Ts': String(ts),
      'X-Kyoto-Nonce': nonce,
      'X-Kyoto-Sig': signature,
      'X-Kyoto-Cert': cert,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MiruDLClient {
  /**
   * @param {{
   *   anilabBase?: string,
   *   kyotoBase?: string,
   *   kyotoMinGapMs?: number,
   *   kyotoRetryDelaysMs?: number[],
   *   fetchImpl?: typeof fetch,
   *   timeoutMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.anilabBase = (options.anilabBase || MIRUDL_CONSTANTS.ANILAB_API).replace(/\/+$/, '');
    this.kyotoBase = (options.kyotoBase || MIRUDL_CONSTANTS.KYOTO_API).replace(/\/+$/, '');
    this.kyotoMinGapMs = options.kyotoMinGapMs ?? MIRUDL_CONSTANTS.KYOTO_MIN_GAP_MS;
    this.kyotoRetryDelaysMs = options.kyotoRetryDelaysMs || [...MIRUDL_CONSTANTS.KYOTO_RETRY_DELAYS_MS];
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;

    this._kyotoInnerKey = deriveKyotoInnerKey();
    this._kyotoLastCallAt = 0;
    this._kyotoQueue = Promise.resolve();

    this._homeCache = null;
    this._homeCacheAt = 0;
    this._categoryCache = null;
    this._categoryCacheAt = 0;
    this._serverCache = new Map();
    this._titleCache = new Map();
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

  async _anilabGet(url, referer = `${this.anilabBase}/`) {
    const res = await this._fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'User-Agent': MIRUDL_CONSTANTS.ANILAB_UA,
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: referer,
      },
    });
    if (!res.ok) {
      throw new Error(`AniLab HTTP ${res.status} for ${url}`);
    }
    return res.text();
  }

  async _paceKyoto() {
    let release;
    const prev = this._kyotoQueue;
    this._kyotoQueue = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      const waitMs = this._kyotoLastCallAt + this.kyotoMinGapMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this._kyotoLastCallAt = Date.now();
    } finally {
      release();
    }
  }

  /**
   * Perform a serialized, HMAC-signed empty POST to Kyoto Player (`MiruClient.kyotoPost`).
   *
   * @param {string} pathWithQuery
   * @returns {Promise<any>}
   */
  async kyotoPost(pathWithQuery) {
    const normalizedPath = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = this.kyotoRetryDelaysMs[attempt - 1] ?? 5000;
        await sleep(delay);
      }
      await this._paceKyoto();
      const { headers } = signKyotoRequest(normalizedPath, {
        innerKey: this._kyotoInnerKey,
      });
      const res = await this._fetchWithTimeout(`${this.kyotoBase}${normalizedPath}`, {
        method: 'POST',
        headers,
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 429) {
        continue;
      }
      if (!res.ok) {
        throw new Error(`Kyoto HTTP ${res.status} on ${normalizedPath}`);
      }
      return JSON.parse(text);
    }

    const version = await this.fetchServerAppVersion().catch(() => null);
    const suffix = version ? ` (source app v${version})` : '';
    throw new Error(`Kyoto source rejected the request${suffix}`);
  }

  async fetchServerAppVersion() {
    const res = await this._fetchWithTimeout(`${this.kyotoBase}/update`, {
      method: 'POST',
      headers: {
        'app-id': MIRUDL_CONSTANTS.KYOTO_APP_ID,
        'app-version': MIRUDL_CONSTANTS.KYOTO_APP_VERSION,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.version || null;
  }

  async getHomeSections() {
    if (!this._homeCache || Date.now() - this._homeCacheAt > 300_000) {
      this._homeCache = JSON.parse(await this._anilabGet(`${this.anilabBase}/home`));
      this._homeCacheAt = Date.now();
    }
    const sections = Array.isArray(this._homeCache?.sections) ? this._homeCache.sections : [];
    const results = [];
    for (const sec of sections) {
      const posts = Array.isArray(sec?.posts) ? sec.posts : [];
      if (!posts.length) continue;
      const items = posts
        .filter((p) => p && Number(p.id) > 0)
        .map((p) => ({
          id: String(p.id),
          title: this._titleCache.get(String(p.id)) || p.title || '',
          thumbnail: p.poster || '',
          sourceId: 'anilab',
        }));
      if (items.length) {
        results.push({ title: sec.name || '', sourceId: 'anilab', posts: items });
      }
    }
    return results;
  }

  async getCategories() {
    if (!this._categoryCache || Date.now() - this._categoryCacheAt > 86_400_000) {
      const data = JSON.parse(await this._anilabGet(`${this.anilabBase}/categories`));
      this._categoryCache = Array.isArray(data?.categories) ? data.categories : [];
      this._categoryCacheAt = Date.now();
    }
    return this._categoryCache.map((c) => ({
      id: String(c.id),
      title: c.name || '',
      sourceId: 'anilab',
    }));
  }

  async getCategoryPosts(categoryId, page = 1) {
    const url = `${this.anilabBase}/category?id=${encodeURIComponent(categoryId)}&page=${encodeURIComponent(page)}`;
    const data = JSON.parse(await this._anilabGet(url));
    const posts = Array.isArray(data?.posts) ? data.posts : [];
    const items = posts.map((p) => ({
      id: String(p.id),
      title: p.title || '',
      thumbnail: p.poster || '',
      sourceId: 'anilab',
    }));
    await this.enrichTitles(items);
    return items;
  }

  async search(query, page = 1) {
    const url = `${this.anilabBase}/search?query=${encodeURIComponent(query)}&page=${encodeURIComponent(page)}`;
    const data = JSON.parse(await this._anilabGet(url));
    const posts = Array.isArray(data?.posts) ? data.posts : [];
    const items = posts.map((p) => ({
      id: String(p.id),
      title: p.title || '',
      thumbnail: p.poster || '',
      sourceId: 'anilab',
    }));
    await this.enrichTitles(items);
    return items;
  }

  async getAnimeDetails(animeId) {
    const rawId = String(animeId || '');
    const id = rawId.includes('-') ? rawId.split('-').pop() : rawId;
    const data = JSON.parse(await this._anilabGet(`${this.anilabBase}/post?id=${encodeURIComponent(id)}`));
    if (data?.title) {
      this._rememberTitle(id, data.title);
    }
    return {
      ...data,
      id: String(data?.id ?? id),
      sourceId: 'anilab',
    };
  }

  _rememberTitle(id, title) {
    if (!id || !title) return;
    if (this._titleCache.size >= 500 && !this._titleCache.has(id)) {
      const oldestKey = this._titleCache.keys().next().value;
      if (oldestKey !== undefined) this._titleCache.delete(oldestKey);
    }
    this._titleCache.set(String(id), title);
  }

  async enrichTitles(items, concurrency = 8) {
    const missing = (items || []).filter((item) => {
      if (!item?.id) return false;
      const cached = this._titleCache.get(String(item.id));
      if (cached) {
        item.title = cached;
        return false;
      }
      return !item.title;
    });
    if (!missing.length) return items;

    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
      while (idx < missing.length) {
        const item = missing[idx++];
        try {
          const detail = await this.getAnimeDetails(item.id);
          if (detail?.title) {
            item.title = detail.title;
          }
        } catch {
          // Best-effort enrichment, matches MiruClient.lambda$enrichTitles$0
        }
      }
    });
    await Promise.all(workers);
    return items;
  }

  _parseServers(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList
      .filter(Boolean)
      .map((s) => {
        const id = String(s.id || '');
        const lang = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : s.lang || 'jpn';
        return {
          name: s.name || 'Source',
          id,
          language: lang,
          type: 'KYOTO',
          sourceId: 'anilab',
        };
      });
  }

  async getEpisodes(animeId) {
    const data = await this.kyotoPost(`/episodes?id=${encodeURIComponent(animeId)}&token=`);
    const list = Array.isArray(data?.list) ? data.list : [];
    return list.map((ep) => {
      const epId = String(ep.id);
      const servers = this._parseServers(ep.servers);
      if (servers.length) {
        this._serverCache.set(epId, servers);
      }
      return {
        id: epId,
        title: ep.name || '',
        number: Number.parseInt(String(ep.number ?? '0'), 10) || 0,
        filler: Boolean(ep.filler),
        servers,
        sourceId: 'anilab',
      };
    });
  }

  async getEpisodeLanguages(episodeId) {
    const key = String(episodeId);
    const cached = this._serverCache.get(key);
    if (cached?.length) return cached;
    const data = await this.kyotoPost(
      `/servers?id=${encodeURIComponent(key)}&episode=${encodeURIComponent(key)}`
    );
    const servers = this._parseServers(data?.list);
    this._serverCache.set(key, servers);
    return servers;
  }

  /**
   * Resolve the master `.m3u8` playlist URL via Kyoto `/stream`.
   *
   * @param {string} episodeId
   * @param {string} [language='jpn']
   * @returns {Promise<string>}
   */
  async resolveMaster(episodeId, language = 'jpn') {
    const serverParam = `${episodeId}/${language}`;
    const data = await this.kyotoPost(
      `/stream?id=${encodeURIComponent(episodeId)}&server=${encodeURIComponent(serverParam)}`
    );
    const link = data?.link;
    if (!link) {
      throw new Error(`No stream link returned by Kyoto for episode=${episodeId} lang=${language}`);
    }
    return link;
  }

  /**
   * Parse master HLS qualities using `HlsDownloader` / `MiruClient.getQualities` headers.
   *
   * @param {string} masterUrl
   */
  async getQualities(masterUrl) {
    const res = await this._fetchWithTimeout(masterUrl, {
      method: 'GET',
      headers: {
        'User-Agent': MIRUDL_CONSTANTS.HLS_UA,
        Referer: MIRUDL_CONSTANTS.HLS_REFERER,
      },
    });
    if (!res.ok) {
      throw new Error(`HLS playlist HTTP ${res.status} for ${masterUrl}`);
    }
    const text = await res.text();
    const parsed = parseMasterPlaylist(text, masterUrl);
    if (!parsed.isMaster) {
      return {
        isMaster: false,
        variants: [{ quality: 'Auto', label: 'Auto', url: masterUrl, score: 0 }],
        mediaTracks: parsed.mediaTracks,
      };
    }
    return parsed;
  }

  /**
   * End-to-end stream & download resolution for web integration.
   * Unlike `MiruDL` APK's `DownloadService.runSingleJob` (which discarded the user's preferred
   * quality and always picked `pickBestVariant`), this preserves `preferredQuality`.
   *
   * @param {string} episodeId
   * @param {{ language?: string, preferredQuality?: string }} [options]
   */
  async resolvePlayback(episodeId, options = {}) {
    const servers = await this.getEpisodeLanguages(episodeId).catch(() => []);
    const preferredLang = options.language || 'jpn';
    const matchedServer =
      servers.find((s) => s.language === preferredLang) || servers[0] || { language: preferredLang };

    const masterUrl = await this.resolveMaster(episodeId, matchedServer.language);
    let variants = [];
    let selectedUrl = masterUrl;
    let selectedQuality = 'Auto';

    try {
      const info = await this.getQualities(masterUrl);
      variants = info.variants;
      if (options.preferredQuality && options.preferredQuality.toLowerCase() !== 'auto') {
        const chosen = pickVariantByQuality(variants, options.preferredQuality);
        if (chosen) {
          selectedUrl = chosen.url;
          selectedQuality = chosen.quality;
        }
      } else if (variants.length > 0) {
        const best = pickBestVariant(variants);
        selectedQuality = best ? `${best.quality} (Auto)` : 'Auto';
      }
    } catch {
      // Fall back to masterUrl directly if upstream variant probe fails
    }

    return {
      provider: 'mirudl',
      episodeId: String(episodeId),
      language: matchedServer.language,
      availableLanguages: servers,
      masterUrl,
      selectedUrl,
      selectedQuality,
      variants,
      mediaHeaders: {
        'User-Agent': MIRUDL_CONSTANTS.HLS_UA,
        Referer: MIRUDL_CONSTANTS.HLS_REFERER,
      },
      unwrapTs: false,
    };
  }
}
