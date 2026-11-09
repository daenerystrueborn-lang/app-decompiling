/**
 * Browser Website Player SDK (`AnimeSitePlayer`)
 *
 * Integrates both MiruDL and AniFam playback cleanly into any website:
 *  - Plays MiruDL HLS via `/api/mirudl/play` -> `/api/proxy/hls`
 *  - Plays AniFam's 3 modes via `/api/anifam/play`:
 *      1) `hls` (Direct HLS via `hls.js` / native Safari HLS)
 *      2) `resolved_hls` (Iframe-resolved HLS unwrapped server-side by `TsUnwrapperTransform`)
 *      3) `iframe` (WebView/Embed fallback rendered in sandboxed `<iframe>`)
 *  - Automatic server fallback on fatal playback errors
 *  - WebVTT subtitle injection (`<track>`) + intro/outro skip cues (`skip.intro`, `skip.outro`).
 */

export class AnimeSitePlayer {
  /**
   * @param {{
   *   videoEl: HTMLVideoElement,
   *   iframeEl?: HTMLIFrameElement | null,
   *   apiBase?: string,
   *   hlsConstructor?: any,
   *   onStateChange?: (state: any) => void,
   *   onSkipCue?: (cue: { type: 'intro'|'outro', start: number, end: number } | null) => void,
   *   onError?: (err: Error) => void,
   * }} options
   */
  constructor(options) {
    this.videoEl = options.videoEl;
    this.iframeEl = options.iframeEl || null;
    this.apiBase = (options.apiBase || '').replace(/\/+$/, '');
    this.Hls = options.hlsConstructor ?? globalThis.Hls ?? null;
    this.onStateChange = options.onStateChange || (() => {});
    this.onSkipCue = options.onSkipCue || (() => {});
    this.onError = options.onError || (() => {});

    this._hls = null;
    this._currentSession = null;
    this._triedServerIndices = new Set();
    this._onTimeUpdate = () => this._checkSkipCue();
    this.videoEl.addEventListener('timeupdate', this._onTimeUpdate);
  }

  _emit(state) {
    this._currentSession = state;
    this.onStateChange(state);
  }

  _clearSubtitles() {
    for (const track of [...this.videoEl.querySelectorAll('track[data-sdk="1"]')]) {
      track.remove();
    }
  }

  _attachSubtitles(subtitles = []) {
    this._clearSubtitles();
    for (const sub of subtitles) {
      const trackEl = document.createElement('track');
      trackEl.dataset.sdk = '1';
      trackEl.kind = 'subtitles';
      trackEl.label = sub.label || sub.lang || 'Subtitles';
      trackEl.srclang = sub.lang || 'en';
      trackEl.src = `${this.apiBase}${sub.proxyUrl || sub.url}`;
      if (sub.default) trackEl.default = true;
      this.videoEl.appendChild(trackEl);
    }
  }

  _teardownMedia() {
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    this.videoEl.pause();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();
    this._clearSubtitles();
    if (this.iframeEl) {
      this.iframeEl.src = 'about:blank';
      this.iframeEl.hidden = true;
    }
    this.videoEl.hidden = false;
  }

  _mountHlsUrl(hlsUrl, onFatal) {
    this._teardownMedia();
    const resolvedUrl = hlsUrl.startsWith('http') ? hlsUrl : `${this.apiBase}${hlsUrl}`;

    if (this.Hls && this.Hls.isSupported()) {
      const hls = new this.Hls({
        enableWorker: true,
        lowLatencyMode: false,
      });
      this._hls = hls;
      hls.loadSource(resolvedUrl);
      hls.attachMedia(this.videoEl);
      hls.on(this.Hls.Events.MANIFEST_PARSED, () => {
        this.videoEl.play().catch(() => {});
      });
      hls.on(this.Hls.Events.ERROR, (_ev, data) => {
        if (data?.fatal && onFatal) {
          onFatal(new Error(`HLS fatal error: ${data.type} / ${data.details}`));
        }
      });
      return;
    }

    if (this.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      this.videoEl.src = resolvedUrl;
      this.videoEl.play().catch(() => {});
      return;
    }

    const err = new Error('HLS playback requires hls.js or native Safari HLS support');
    this.onError(err);
    throw err;
  }

  _mountIframe(embedUrl) {
    this._teardownMedia();
    if (!this.iframeEl) {
      throw new Error('iframeEl must be provided to support AniFam Mode 3 (Web Embed fallback)');
    }
    this.videoEl.hidden = true;
    this.iframeEl.hidden = false;
    this.iframeEl.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-presentation allow-forms'
    );
    this.iframeEl.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    this.iframeEl.src = embedUrl;
  }

  _checkSkipCue() {
    const skip = this._currentSession?.skip;
    if (!skip) {
      this.onSkipCue(null);
      return;
    }
    const sec = this.videoEl.currentTime;
    if (skip.intro && sec >= skip.intro.start && sec < skip.intro.end) {
      this.onSkipCue({ type: 'intro', start: skip.intro.start, end: skip.intro.end });
      return;
    }
    if (skip.outro && sec >= skip.outro.start && sec < skip.outro.end) {
      this.onSkipCue({ type: 'outro', start: skip.outro.start, end: skip.outro.end });
      return;
    }
    this.onSkipCue(null);
  }

  jumpToSeconds(seconds) {
    if (Number.isFinite(seconds)) {
      this.videoEl.currentTime = seconds;
    }
  }

  /**
   * Load and play a MiruDL episode via `/api/mirudl/play`.
   */
  async playMiruDL(episodeId, options = {}) {
    const qs = new URLSearchParams({
      episodeId: String(episodeId),
      lang: options.lang || 'jpn',
      quality: options.quality || '1080p',
    });
    const res = await fetch(`${this.apiBase}/api/mirudl/play?${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const state = {
      provider: 'mirudl',
      mode: 'hls',
      status: 'ready',
      ...data,
    };
    this._emit(state);
    this._mountHlsUrl(
      options.quality && options.quality !== 'auto'
        ? data.proxySelectedHlsUrl || data.proxyHlsUrl
        : data.proxyHlsUrl,
      (err) => this.onError(err)
    );
    return state;
  }

  /**
   * Load and play an AniFam episode via `/api/anifam/play` (handles all 3 modes + fallback).
   */
  async playAniFam(episodeId, options = {}) {
    if (!Number.isInteger(options.serverIndex)) {
      this._triedServerIndices.clear();
    }

    const res = await fetch(`${this.apiBase}/api/anifam/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        episodeId: Number(episodeId),
        track: options.track || 'sub',
        serverIndex: Number.isInteger(options.serverIndex) ? options.serverIndex : undefined,
        preferredServerKey: options.preferredServerKey || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const state = { provider: 'anifam', ...data };
    this._emit(state);

    if (data.status !== 'ready') {
      return state;
    }

    if (Number.isInteger(data.sourceIndex)) {
      this._triedServerIndices.add(data.sourceIndex);
    }

    if (data.mode === 'iframe') {
      this._mountIframe(data.embedUrl);
      return state;
    }

    this._mountHlsUrl(data.proxyHlsUrl, async (err) => {
      // Automatic fallback to next untried server in `data.servers`
      const nextServer = (data.servers || []).find((s) => !this._triedServerIndices.has(s.index));
      if (nextServer) {
        try {
          await this.playAniFam(episodeId, {
            track: data.track,
            serverIndex: nextServer.index,
          });
          return;
        } catch (fallbackErr) {
          this.onError(fallbackErr);
          return;
        }
      }
      this.onError(err);
    });

    if (Array.isArray(data.subtitles) && data.subtitles.length) {
      this._attachSubtitles(data.subtitles);
    }
    return state;
  }

  destroy() {
    this.videoEl.removeEventListener('timeupdate', this._onTimeUpdate);
    this._teardownMedia();
  }
}
