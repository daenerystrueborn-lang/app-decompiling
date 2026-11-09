/**
 * Frontend Controller for the Anime Stream & Download Web App (`public/js/site-app.js`)
 */

import { AnimeSitePlayer } from '/js/site-player.js';
import { WebEpisodeDownloader } from '/js/web-downloader.js';

const QUICK_TAGS = [
  'Frieren',
  'Solo Leveling',
  'One Piece',
  'Jujutsu Kaisen',
  'Dandadan',
  'Demon Slayer',
];

const POSTER_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 170"><rect width="120" height="170" fill="#1b2332"/><text x="60" y="88" font-family="system-ui,sans-serif" font-size="13" fill="#7c8da6" text-anchor="middle">ANIME</text></svg>`
  );

let currentProvider = 'anifam';
let currentAnime = null;
let currentEpisode = null;
let currentSession = null;
let downloadAbort = null;
let activeSkipCue = null;

const el = {
  tabAnifam: document.getElementById('tab-anifam'),
  tabMirudl: document.getElementById('tab-mirudl'),
  tabDemo: document.getElementById('tab-demo'),
  healthPill: document.getElementById('health-pill'),
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  quickTags: document.getElementById('quick-tags'),
  btnReloadHome: document.getElementById('btn-reload-home'),
  statusBanner: document.getElementById('status-banner'),
  catalogTitle: document.getElementById('catalog-title'),
  searchResults: document.getElementById('search-results'),
  animeMeta: document.getElementById('anime-meta'),
  episodesList: document.getElementById('episodes-list'),
  playerTitle: document.getElementById('player-title'),
  modeBadge: document.getElementById('player-mode-badge'),
  trackSelect: document.getElementById('track-select'),
  qualitySelect: document.getElementById('quality-select'),
  videoEl: document.getElementById('video-player'),
  iframeEl: document.getElementById('embed-player'),
  skipBtn: document.getElementById('skip-btn'),
  serverBar: document.getElementById('server-bar'),
  btnDlServer: document.getElementById('btn-dl-server'),
  btnDlBrowser: document.getElementById('btn-dl-browser'),
  btnDlCancel: document.getElementById('btn-dl-cancel'),
  dlProgressWrap: document.getElementById('dl-progress-wrap'),
  dlProgress: document.getElementById('dl-progress'),
  dlProgressText: document.getElementById('dl-progress-text'),
  activityLog: document.getElementById('activity-log'),
};

const downloader = new WebEpisodeDownloader();
const player = new AnimeSitePlayer({
  videoEl: el.videoEl,
  iframeEl: el.iframeEl,
  onStateChange: (state) => {
    currentSession = state;
    el.modeBadge.hidden = false;
    el.modeBadge.textContent = `${state.provider.toUpperCase()} • ${state.mode || state.status}`;
    renderServerBar(state);
    const canDownload = Boolean(state.downloadUrl || state.proxyHlsUrl);
    el.btnDlServer.disabled = !canDownload;
    el.btnDlBrowser.disabled = !state.proxyHlsUrl;
    logActivity(
      `Stream ${state.status}: ${state.provider} (${state.mode || 'unknown'}${state.unwrapTs ? ', TS-unwrap ON' : ''})`
    );
  },
  onSkipCue: (cue) => {
    activeSkipCue = cue;
    if (!cue) {
      el.skipBtn.hidden = true;
      return;
    }
    el.skipBtn.hidden = false;
    el.skipBtn.textContent = cue.type === 'intro' ? 'Skip Intro' : 'Skip Outro';
  },
  onError: (err) => {
    showStatus(err.message, true);
    logActivity(`Player error: ${err.message}`);
  },
});

function logActivity(msg) {
  const li = document.createElement('li');
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  li.textContent = `[${ts}] ${msg}`;
  el.activityLog.prepend(li);
  while (el.activityLog.children.length > 14) {
    el.activityLog.lastElementChild.remove();
  }
}

function showStatus(msg, isError = false, action = null) {
  el.statusBanner.hidden = !msg;
  el.statusBanner.innerHTML = '';
  el.statusBanner.classList.toggle('error', isError);
  if (!msg) return;

  const span = document.createElement('span');
  span.textContent = msg;
  el.statusBanner.appendChild(span);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-action';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.statusBanner.appendChild(btn);
  }
}

function formatUptime(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

async function refreshHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (!res.ok) throw new Error('offline');
    const originHost = data.anifamActiveOrigin
      ? new URL(data.anifamActiveOrigin).hostname
      : 'anifam';
    el.healthPill.textContent = `Server Online • Up ${formatUptime(data.uptimeSeconds || 0)} • ${originHost} • ${data.stats?.streamsResolved ?? 0} streams`;
    el.healthPill.classList.remove('offline');
  } catch {
    el.healthPill.textContent = 'Server Connecting...';
    el.healthPill.classList.add('offline');
  }
}

function renderQuickTags() {
  el.quickTags.innerHTML = '';
  for (const tag of QUICK_TAGS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      el.searchInput.value = tag;
      runSearch(tag);
    });
    el.quickTags.appendChild(btn);
  }
}

function renderAnimeList(items, heading = 'Catalog') {
  el.catalogTitle.textContent = heading;
  el.searchResults.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No anime found in this view.';
    el.searchResults.appendChild(empty);
    return;
  }

  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card' + (currentAnime?.id === item.id ? ' active' : '');

    const img = document.createElement('img');
    img.className = 'poster';
    img.loading = 'lazy';
    img.alt = item.title;
    img.src = item.poster || POSTER_FALLBACK;
    img.addEventListener('error', () => {
      img.src = POSTER_FALLBACK;
    });

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const strong = document.createElement('strong');
    strong.textContent = item.title || `Anime #${item.id}`;
    const sub = document.createElement('span');
    sub.textContent = item.subtitle ? `${item.subtitle} • ID ${item.id}` : `ID ${item.id}`;

    meta.append(strong, sub);
    btn.append(img, meta);
    btn.addEventListener('click', () => loadEpisodes(item, btn));
    el.searchResults.appendChild(btn);
  }
}

async function loadHomeCatalog(provider = currentProvider, { allowAutoFallback = false } = {}) {
  showStatus(`Loading ${provider.toUpperCase()} catalog...`);
  try {
    const res = await fetch(`/api/catalog/home?provider=${encodeURIComponent(provider)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const items = data.items || [];
    if (!items.length) {
      throw new Error(`${provider.toUpperCase()} returned an empty catalog`);
    }

    const sectionName = data.sections?.[0]?.title || `${provider.toUpperCase()} Featured`;
    showStatus('');
    renderAnimeList(items, `${sectionName} (${items.length})`);
    logActivity(`Loaded ${items.length} anime from ${provider.toUpperCase()}`);

    if (provider === 'demo' && items[0]) {
      await loadEpisodes(items[0], null, true);
    }
  } catch (err) {
    logActivity(`${provider.toUpperCase()} home unavailable: ${err.message}`);
    if (allowAutoFallback && provider === 'anifam') {
      showStatus(`AniFam upstream unavailable (${err.message}). Trying MiruDL...`);
      await setProvider('mirudl', { allowAutoFallback: true });
      return;
    }
    if (allowAutoFallback && provider === 'mirudl') {
      showStatus(`Live upstreams unavailable from this host (${err.message}). Switched to Demo HLS Showcase.`);
      await setProvider('demo', { allowAutoFallback: false });
      return;
    }
    showStatus(`${provider.toUpperCase()} error: ${err.message}`, true, {
      label: 'Try Demo HLS',
      onClick: () => setProvider('demo'),
    });
    renderAnimeList([], `${provider.toUpperCase()} Catalog`);
  }
}

async function runSearch(query) {
  const q = query.trim();
  if (!q) return;
  showStatus(`Searching ${currentProvider.toUpperCase()} for "${q}"...`);
  try {
    const res = await fetch(
      `/api/catalog/search?provider=${encodeURIComponent(currentProvider)}&q=${encodeURIComponent(q)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const items = data.items || [];
    showStatus(items.length ? '' : `No matches for "${q}" on ${currentProvider.toUpperCase()}`);
    renderAnimeList(items, `Results for "${q}" (${items.length})`);
    logActivity(`Search "${q}" on ${currentProvider.toUpperCase()} -> ${items.length} hits`);
  } catch (err) {
    showStatus(err.message, true, {
      label: 'Try Demo HLS',
      onClick: () => setProvider('demo'),
    });
    logActivity(`Search failed: ${err.message}`);
  }
}

async function loadEpisodes(anime, clickedCard = null, autoPlayFirst = false) {
  currentAnime = anime;
  for (const card of el.searchResults.querySelectorAll('.card.active')) {
    card.classList.remove('active');
  }
  if (clickedCard) clickedCard.classList.add('active');

  el.animeMeta.textContent = anime.title || `Anime ${anime.id}`;
  showStatus(`Loading episodes for ${anime.title}...`);

  try {
    const res = await fetch(
      `/api/catalog/episodes?provider=${encodeURIComponent(currentProvider)}&animeId=${encodeURIComponent(anime.id)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const eps = data.episodes || [];
    showStatus(eps.length ? '' : 'No episodes returned for this title.');
    el.episodesList.innerHTML = '';

    for (const ep of eps) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ep-btn' + (currentEpisode?.id === ep.id ? ' active' : '');
      const epLabel = `EP ${ep.number ?? ''}`;
      btn.textContent = ep.title ? `${epLabel} • ${ep.title}` : epLabel;
      btn.addEventListener('click', () => startEpisode(anime, ep, btn));
      el.episodesList.appendChild(btn);
    }
    logActivity(`Loaded ${eps.length} episode(s) for "${anime.title}"`);

    if (autoPlayFirst && eps[0]) {
      const firstBtn = el.episodesList.querySelector('.ep-btn');
      await startEpisode(anime, eps[0], firstBtn);
    }
  } catch (err) {
    showStatus(err.message, true);
    logActivity(`Episode load failed: ${err.message}`);
  }
}

async function startEpisode(anime, ep, clickedBtn = null) {
  currentEpisode = { ...ep, animeTitle: anime.title || 'Anime' };
  for (const b of el.episodesList.querySelectorAll('.ep-btn.active')) {
    b.classList.remove('active');
  }
  if (clickedBtn) clickedBtn.classList.add('active');

  el.playerTitle.textContent = `${currentEpisode.animeTitle} — EP ${ep.number ?? ep.id}`;
  showStatus(`Resolving ${currentProvider.toUpperCase()} playback...`);

  try {
    if (currentProvider === 'demo') {
      await player.playDemo(ep.id, { quality: el.qualitySelect.value });
    } else if (currentProvider === 'mirudl') {
      const lang = el.trackSelect.value === 'dub' ? 'eng' : 'jpn';
      await player.playMiruDL(ep.id, { lang, quality: el.qualitySelect.value });
    } else {
      await player.playAniFam(ep.id, { track: el.trackSelect.value });
    }
    showStatus('');
    refreshHealth();
  } catch (err) {
    showStatus(err.message, true);
    logActivity(`Playback resolve failed: ${err.message}`);
  }
}

function renderServerBar(state) {
  el.serverBar.innerHTML = '';
  if (!state?.servers?.length) return;
  for (const s of state.servers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'server-chip' + (s.index === state.sourceIndex ? ' active' : '');
    btn.textContent = s.isWebOnly ? `${s.label} [Web]` : s.label;
    btn.addEventListener('click', () => {
      if (currentEpisode && currentProvider === 'anifam') {
        player
          .playAniFam(currentEpisode.id, {
            track: el.trackSelect.value,
            serverIndex: s.index,
          })
          .catch((err) => showStatus(err.message, true));
      }
    });
    el.serverBar.appendChild(btn);
  }
}

async function setProvider(p, opts = {}) {
  currentProvider = p;
  el.tabAnifam.classList.toggle('active', p === 'anifam');
  el.tabMirudl.classList.toggle('active', p === 'mirudl');
  el.tabDemo.classList.toggle('active', p === 'demo');
  el.episodesList.innerHTML = '';
  el.animeMeta.textContent = 'Select an anime to load episodes.';
  await loadHomeCatalog(p, opts);
}

// Wire events
el.tabAnifam.addEventListener('click', () => setProvider('anifam'));
el.tabMirudl.addEventListener('click', () => setProvider('mirudl'));
el.tabDemo.addEventListener('click', () => setProvider('demo'));
el.btnReloadHome.addEventListener('click', () => loadHomeCatalog(currentProvider));

el.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(el.searchInput.value);
});

el.skipBtn.addEventListener('click', () => {
  if (activeSkipCue) player.jumpToSeconds(activeSkipCue.end);
});

el.btnDlServer.addEventListener('click', () => {
  if (!currentSession) return;
  const title = `${currentEpisode?.animeTitle || 'anime'}-ep-${currentEpisode?.number || currentEpisode?.id || 1}`;
  downloader.triggerServerDownload({
    downloadUrl: currentSession.downloadUrl,
    quality: el.qualitySelect.value,
    title,
  });
  logActivity(`Started server stream download (.mp4 @ ${el.qualitySelect.value})`);
  setTimeout(refreshHealth, 800);
});

el.btnDlBrowser.addEventListener('click', async () => {
  if (!currentSession?.proxyHlsUrl) return;
  downloadAbort = new AbortController();
  el.dlProgressWrap.hidden = false;
  el.btnDlCancel.hidden = false;
  el.btnDlBrowser.disabled = true;
  const title = `${currentEpisode?.animeTitle || 'anime'}-ep-${currentEpisode?.number || currentEpisode?.id || 1}`;
  logActivity(`Started browser concurrent download (${el.qualitySelect.value})`);

  try {
    await downloader.downloadInBrowserWithProgress({
      proxyHlsUrl: currentSession.proxyHlsUrl,
      preferredQuality: el.qualitySelect.value,
      filename: `${title}.mp4`,
      signal: downloadAbort.signal,
      onProgress: (p) => {
        el.dlProgress.value = p.percent;
        const mb = (p.bytesDownloaded / (1024 * 1024)).toFixed(1);
        const mbps = ((p.speedBytesPerSec * 8) / 1_000_000).toFixed(1);
        el.dlProgressText.textContent = `${p.percent}% (${p.completed}/${p.total} segs • ${mb} MB • ${mbps} Mbps • ${p.quality})`;
      },
    });
    logActivity('Browser download completed!');
  } catch (err) {
    const cancelled = err.name === 'AbortError';
    showStatus(cancelled ? 'Download cancelled' : err.message, !cancelled);
    logActivity(cancelled ? 'Browser download cancelled' : `Download failed: ${err.message}`);
  } finally {
    el.btnDlCancel.hidden = true;
    el.btnDlBrowser.disabled = false;
  }
});

el.btnDlCancel.addEventListener('click', () => {
  if (downloadAbort) downloadAbort.abort();
});

// Boot site immediately
renderQuickTags();
refreshHealth();
setInterval(refreshHealth, 30_000);
loadHomeCatalog('anifam', { allowAutoFallback: true });
