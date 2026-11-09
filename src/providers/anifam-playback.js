/**
 * AniFam 3-Mode Playback & Fallback State Machine
 *
 * Exact JS port of `O7/J1`, `O7/V1`, `O7/U1`, `O7/b2`, `O7/W1`, and `J8/c.U()`
 * from `Anifam-App-Latest-v0.2.9.apk`.
 *
 * The 3 modes:
 *  1. `hls`       — Direct HLS (`kind === "hls"`), native player + `mediaHeaders` + mirror rotation (`V1.j`)
 *  2. `resolved`  — Native-resolved iframe (`V1.b`): `POST episodes/{id}/resolve` -> native HLS + `unwrapTs: true`
 *  3. `iframe`    — WebView/iframe embed fallback (`V1.c`): embed URL (`embedUrl` or `url`) rendered in unsandboxed `<iframe>`
 *
 * Fallback pipeline (`J1.i` / `J1.h`):
 *  - On error/stall (`20s` buffering or `9s` iframe resolve stall), places failing source on `300,000 ms` cooldown
 *  - Tries next untried native-capable source (`V1.d`)
 *  - Retries `hls` source once (`hlsRetried = true`)
 *  - Falls back to WebView/iframe embed (`V1.c`)
 *  - Emits `entitlement_required` on HTTP `403`, or `failed` when all sources are exhausted.
 */

import { ANIFAM_CONSTANTS, AniFamApiError } from './anifam-client.js';

export const COOLDOWN_MS = 300_000; // 5 minutes (`O7/J1.h`)

export function extractHost(url) {
  try {
    return new URL(String(url)).hostname || null;
  } catch {
    return null;
  }
}

/** Matches `O7/V1.g`: checks `megaplay.buzz` or `*.megaplay.buzz`. */
export function isMegaplayHost(source) {
  const host = extractHost(source?.url);
  if (!host) return false;
  const lower = host.toLowerCase();
  return lower === ANIFAM_CONSTANTS.MEGAPLAY_HOST || lower.endsWith(`.${ANIFAM_CONSTANTS.MEGAPLAY_HOST}`);
}

export function isDirectHls(source) {
  return source?.kind === 'hls' && Boolean(source?.url && String(source.url).trim());
}

/** Matches `O7/V1.b`: iframe with `serverId != null` and (`resolvable !== false` or `megaplay.buzz`). */
export function isResolvableIframe(source) {
  if (!source || source.kind !== 'iframe') return false;
  if (source.serverId === null || source.serverId === undefined) return false;
  return source.resolvable === true || source.resolvable == null || isMegaplayHost(source);
}

/** Matches `O7/V1.c`: iframe usable in WebView/embed (`embedUrl != null`, `megaplay.buzz`, or `https`). */
export function isWebEmbedIframe(source) {
  if (!source || source.kind !== 'iframe') return false;
  if (source.embedUrl) return true;
  if (isMegaplayHost(source)) return true;
  try {
    return new URL(String(source.url)).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Matches `O7/V1.d`: native-capable (`directHls || isResolvableIframe`). */
export function isNativeCapable(source) {
  return isDirectHls(source) || isResolvableIframe(source);
}

/** Matches `O7/V1.e`: cooldown key (`"main"`, `"server:<id>"`, or `"host:<hostname>"`). */
export function getSourceCooldownKey(source) {
  if (source?.kind === 'hls') return 'main';
  if (source?.serverId !== null && source?.serverId !== undefined) {
    return `server:${source.serverId}`;
  }
  return `host:${extractHost(source?.url) || ''}`;
}

/**
 * Matches `O7/V1.h`: `[...mirrors, url]` deduplicated and non-blank.
 *
 * @param {any} source
 * @returns {string[]}
 */
export function collectCandidateUrls(source) {
  const combined = [...(Array.isArray(source?.mirrors) ? source.mirrors : []), source?.url];
  const seen = new Set();
  const out = [];
  for (const item of combined) {
    const trimmed = String(item || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Matches `O7/V1.j`: swap origin of a subtitle/asset URL when switching from primary stream URL to mirror URL.
 *
 * @param {string} assetUrl
 * @param {string} primaryUrl
 * @param {string} activeUrl
 * @returns {string}
 */
export function rewriteAssetOriginForMirror(assetUrl, primaryUrl, activeUrl) {
  if (!assetUrl || !primaryUrl || !activeUrl || primaryUrl === activeUrl) return assetUrl;
  try {
    const pOrigin = new URL(primaryUrl).origin;
    const aOrigin = new URL(activeUrl).origin;
    if (String(assetUrl).startsWith(pOrigin)) {
      return aOrigin + String(assetUrl).slice(pOrigin.length);
    }
  } catch {
    // ignore malformed URIs
  }
  return assetUrl;
}

/**
 * Filter & sort raw `PlaybackDto.sources` (`O7/J1` lines 230–244 + `O7/U1`).
 *
 * @param {any[]} rawSources
 * @returns {any[]}
 */
export function filterAndSortSources(rawSources) {
  const filtered = (Array.isArray(rawSources) ? rawSources : []).filter(
    (s) => isDirectHls(s) || (s?.kind === 'iframe' && (isResolvableIframe(s) || isWebEmbedIframe(s)))
  );
  // Stable sort putting `hls` sources first (`O7/U1`)
  return filtered.sort((a, b) => (a.kind === 'hls' ? 0 : 1) - (b.kind === 'hls' ? 0 : 1));
}

/**
 * Build server display descriptors (`O7/W1` + `J8/c.U()`).
 *
 * @param {any[]} sources
 */
export function buildServerLabels(sources) {
  let backupIndex = 0;
  return sources.map((src, index) => {
    const isNative = isNativeCapable(src);
    if (src.kind === 'hls') {
      return {
        index,
        label: 'AniFam',
        shortLabel: 'AniFam',
        backupIndex: null,
        isNative,
        isWebOnly: !isNative,
        kind: src.kind,
        serverId: src.serverId ?? null,
        cooldownKey: getSourceCooldownKey(src),
      };
    }
    backupIndex += 1;
    return {
      index,
      label: `Backup Server ${backupIndex}`,
      shortLabel: `Backup ${backupIndex}`,
      backupIndex,
      isNative,
      isWebOnly: !isNative,
      kind: src.kind,
      serverId: src.serverId ?? null,
      cooldownKey: getSourceCooldownKey(src),
    };
  });
}

/**
 * Compute prioritized index try order matching `O7/V1.a`.
 * Priority:
 *  1) Native-capable (`hls` / resolvable `iframe`) first (`E7/i0` case 2)
 *  2) Primary vs `backup` (`E7/i0` case 3 — note `V1.a` uses source list + cooldowns + preferredServer)
 *  3) Not in cooldown (`O7/b2`)
 *  4) Matches `preferredServer` (`O7/T1` against `getSourceCooldownKey`)
 *
 * @param {any[]} sources
 * @param {string|null} preferredServerKey
 * @param {Set<string>} cooledDownKeys
 * @returns {number[]}
 */
export function computeTryOrder(sources, preferredServerKey = null, cooledDownKeys = new Set()) {
  const indices = sources.map((_, i) => i);
  return indices.sort((ia, ib) => {
    const a = sources[ia];
    const b = sources[ib];

    const nativeCmp = (isNativeCapable(a) ? 0 : 1) - (isNativeCapable(b) ? 0 : 1);
    if (nativeCmp !== 0) return nativeCmp;

    const kindCmp = (a.kind === 'hls' ? 0 : 1) - (b.kind === 'hls' ? 0 : 1);
    if (kindCmp !== 0) return kindCmp;

    const coolCmp =
      (cooledDownKeys.has(getSourceCooldownKey(a)) ? 1 : 0) -
      (cooledDownKeys.has(getSourceCooldownKey(b)) ? 1 : 0);
    if (coolCmp !== 0) return coolCmp;

    const prefCmp =
      (preferredServerKey && getSourceCooldownKey(a) === preferredServerKey ? 0 : 1) -
      (preferredServerKey && getSourceCooldownKey(b) === preferredServerKey ? 0 : 1);
    return prefCmp;
  });
}

/**
 * In-memory 5-minute cooldown registry (`O7/b2`).
 */
export class SourceCooldownBook {
  constructor(nowFn = () => Date.now(), ttlMs = COOLDOWN_MS) {
    this.nowFn = nowFn;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  markFailed(key) {
    if (!key) return;
    this.map.set(key, this.nowFn() + this.ttlMs);
  }

  getActiveKeys() {
    const now = this.nowFn();
    for (const [key, expiresAt] of this.map.entries()) {
      if (expiresAt <= now) this.map.delete(key);
    }
    return new Set(this.map.keys());
  }

  clear() {
    this.map.clear();
  }
}

/**
 * High-level AniFam playback orchestrator usable in Node backends OR browser apps.
 */
export class AniFamPlaybackController {
  /**
   * @param {{
   *   resolveSource: (episodeId: string|number, serverId: string|number, track: string) => Promise<any>,
   *   resolveRelativeUrl?: (url: string|null|undefined) => string|null,
   *   cooldownBook?: SourceCooldownBook,
   *   preferredServerKey?: string|null,
   * }} deps
   */
  constructor(deps) {
    this.resolveSource = deps.resolveSource;
    this.resolveRelativeUrl = deps.resolveRelativeUrl || ((u) => u || null);
    this.cooldownBook = deps.cooldownBook || new SourceCooldownBook();
    this.preferredServerKey = deps.preferredServerKey || null;

    this.episodeId = null;
    this.track = 'sub';
    this.sources = [];
    this.servers = [];
    this.order = [];
    this.currentIndex = -1;
    this.currentMirrorIndex = 0;
    this.currentCandidateUrls = [];
    this.tried = new Set();
    this.nativeFailed = new Set();
    this.webTried = new Set();
    this.hlsRetried = false;
  }

  /**
   * Initialize from a `POST episodes/{id}/play` (`PlaybackDto`) payload.
   *
   * @param {any} playbackDto
   */
  async loadPlaybackDto(playbackDto) {
    this.episodeId = playbackDto.episodeId;
    this.track = playbackDto.track || 'sub';
    this.sources = filterAndSortSources(playbackDto.sources);
    this.servers = buildServerLabels(this.sources);
    this.tried.clear();
    this.nativeFailed.clear();
    this.webTried.clear();
    this.hlsRetried = false;

    if (!this.sources.length) {
      return { status: 'unavailable', servers: [], episodeId: this.episodeId, track: this.track };
    }

    this.order = computeTryOrder(
      this.sources,
      this.preferredServerKey,
      this.cooldownBook.getActiveKeys()
    );
    return this.activateSource(this.order[0], false);
  }

  /**
   * Activate a specific source index (user click or fallback).
   *
   * @param {number} idx
   * @param {boolean} [isFallback=false]
   */
  async activateSource(idx, isFallback = false) {
    const src = this.sources[idx];
    if (!src) {
      return { status: 'failed', servers: this.servers, episodeId: this.episodeId, track: this.track };
    }

    this.currentIndex = idx;
    this.tried.add(idx);

    if (src.kind === 'hls') {
      return this._buildNativePayload(src, idx, false, isFallback);
    }

    if (isResolvableIframe(src) && !this.nativeFailed.has(idx)) {
      try {
        const resolved = await this.resolveSource(this.episodeId, src.serverId, this.track);
        return this._buildNativePayload(resolved, idx, true, isFallback);
      } catch (err) {
        if (
          (err instanceof AniFamApiError && err.isEntitlementWall()) ||
          err?.status === 403
        ) {
          return {
            status: 'entitlement_required',
            error: err.message,
            sourceIndex: idx,
            servers: this.servers,
          };
        }

        // Resolution failed: downgrade WebView badge if embeddable, mark nativeFailed, advance fallback
        if (isWebEmbedIframe(src) && this.servers[idx]) {
          this.servers[idx] = { ...this.servers[idx], isNative: false, isWebOnly: true };
        }
        this.nativeFailed.add(idx);
        return this.fallbackFromCurrent();
      }
    }

    if (isWebEmbedIframe(src)) {
      const embedUrl = this.resolveRelativeUrl(src.embedUrl) || src.url;
      this.webTried.add(idx);
      this.nativeFailed.add(idx);
      return {
        status: 'ready',
        mode: 'iframe',
        isFallback,
        sourceIndex: idx,
        server: this.servers[idx],
        servers: this.servers,
        embedUrl,
        allowedHosts: [extractHost(embedUrl)].filter(Boolean),
        unwrapTs: false,
      };
    }

    return this.fallbackFromCurrent();
  }

  _buildNativePayload(sourceDto, idx, unwrapTs, isFallback) {
    const candidateUrls = collectCandidateUrls(sourceDto);
    this.currentCandidateUrls = candidateUrls;
    this.currentMirrorIndex = 0;

    const primaryUrl = candidateUrls[0];
    const subtitles = (sourceDto.subtitles || []).map((sub) => ({
      lang: sub.lang || '',
      label: sub.label || sub.lang || 'Subtitles',
      url: sub.url,
      default: Boolean(sub.default),
    }));

    return {
      status: 'ready',
      mode: unwrapTs ? 'resolved_hls' : 'hls',
      isFallback,
      sourceIndex: idx,
      server: this.servers[idx],
      servers: this.servers,
      streamUrl: primaryUrl,
      candidateUrls,
      mediaHeaders: sourceDto.mediaHeaders || {},
      qualities: sourceDto.qualities || [],
      subtitles,
      spriteVtt: sourceDto.spriteVtt || null,
      thumb: sourceDto.thumb || null,
      skip: sourceDto.skip || null,
      duration: sourceDto.duration ?? null,
      unwrapTs,
    };
  }

  /**
   * Handle playback failure/buffering timeout (`O7/J1.h` + `O7/J1.i`):
   *  1) Rotate to next mirror URL in current source if available (`V1.j`)
   *  2) Otherwise put current source on 5-min cooldown and step fallback (`i()`).
   */
  async handlePlaybackError() {
    if (this.currentMirrorIndex + 1 < this.currentCandidateUrls.length) {
      this.currentMirrorIndex += 1;
      const nextUrl = this.currentCandidateUrls[this.currentMirrorIndex];
      const primaryUrl = this.currentCandidateUrls[0];
      return {
        status: 'mirror_switch',
        sourceIndex: this.currentIndex,
        mirrorIndex: this.currentMirrorIndex,
        streamUrl: nextUrl,
        rewriteSubtitleUrl: (subUrl) => rewriteAssetOriginForMirror(subUrl, primaryUrl, nextUrl),
      };
    }

    const currentSource = this.sources[this.currentIndex];
    if (currentSource) {
      this.cooldownBook.markFailed(getSourceCooldownKey(currentSource));
      if (isResolvableIframe(currentSource) || currentSource.kind === 'hls') {
        this.nativeFailed.add(this.currentIndex);
      }
    }
    return this.fallbackFromCurrent();
  }

  /**
   * Exact port of `O7/J1.i(int currentIdx)`.
   */
  async fallbackFromCurrent() {
    // 1. Next untried native-capable source (`hls` or resolvable `iframe`)
    const nextNative = this.order.find(
      (idx) =>
        idx !== this.currentIndex &&
        !this.tried.has(idx) &&
        !this.nativeFailed.has(idx) &&
        isNativeCapable(this.sources[idx])
    );
    if (nextNative !== undefined) {
      return this.activateSource(nextNative, true);
    }

    // 2. Retry `hls` source once if not yet retried (`!this.A`)
    const hlsIdx = this.order.find((idx) => this.sources[idx]?.kind === 'hls');
    if (hlsIdx !== undefined && !this.hlsRetried) {
      this.hlsRetried = true;
      return this.activateSource(hlsIdx, true);
    }

    // 3. Fall back to untried WebView/iframe source (`V1.c`)
    const webIdx = this.order.find(
      (idx) => !this.webTried.has(idx) && isWebEmbedIframe(this.sources[idx])
    );
    if (webIdx !== undefined) {
      this.webTried.add(webIdx);
      this.nativeFailed.add(webIdx);
      return this.activateSource(webIdx, true);
    }

    // 4. All sources exhausted (`O7.E.a`)
    return {
      status: 'failed',
      sourceIndex: this.currentIndex,
      servers: this.servers,
      episodeId: this.episodeId,
      track: this.track,
    };
  }
}
