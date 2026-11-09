/**
 * Unified Node HTTP Integration Server
 *
 * Exposes MiruDL + AniFam + Demo HLS catalog, playback, 3-mode resolver,
 * signed HLS/segment/image proxy (with real-time AniFam TS image-header unwrapping),
 * concurrent HLS streaming downloads, and static web frontend under `public/`.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { MiruDLClient, MIRUDL_CONSTANTS } from './providers/mirudl-client.js';
import { AniFamClient, AniFamApiError } from './providers/anifam-client.js';
import {
  AniFamPlaybackController,
  SourceCooldownBook,
  buildServerLabels,
  collectCandidateUrls,
  computeTryOrder,
  filterAndSortSources,
  isResolvableIframe,
  isWebEmbedIframe,
} from './providers/anifam-playback.js';
import { MediaProxy } from './proxy/media-proxy.js';
import { createHlsDownloadStream, sanitizeFilename } from './download/hls-downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.vtt': 'text/vtt; charset=utf-8',
};

const DEMO_ANIME = [
  {
    id: 'demo-bbb',
    title: 'Big Buck Bunny (Demo HLS Showcase)',
    subtitle: 'Multi-Quality Adaptive HLS • 1080p / 720p / 480p / 360p',
    poster: '',
    episodes: [
      {
        id: 'demo-1',
        number: 1,
        title: 'Full Feature Showcase (Mux Adaptive HLS)',
        streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      },
      {
        id: 'demo-2',
        number: 2,
        title: 'Alternate Demo Stream (Tears of Steel)',
        streamUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
      },
    ],
  },
];

const DEMO_VTT = `WEBVTT

00:00.500 --> 00:04.000
Welcome to the MiruDL + AniFam Web Streaming & Download Demo.

00:04.000 --> 00:12.000
Intro skip cue active — click "Skip Intro" or download this stream as MP4.

00:12.000 --> 00:25.000
Served via the signed Node MediaProxy and concurrent HLS segment pipeline.
`;

function sendJson(res, status, data, method = 'GET') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export function isSafePublicHttpsUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!host || !host.includes('.')) return false;
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host.startsWith('[') || host.includes(':')) return false; // skip IPv6 literals
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 169 && b === 254) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toProxiedPoster(url) {
  if (!url || !String(url).trim()) return '';
  const s = String(url).trim();
  if (s.startsWith('/')) return s;
  if (isSafePublicHttpsUrl(s)) {
    return `/api/proxy/image?url=${encodeURIComponent(s)}`;
  }
  return '';
}

function normalizeAnimeItem(raw, fallbackIdx = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ?? raw.animeId ?? raw.slug ?? raw.malId ?? String(fallbackIdx + 1);
  const title =
    raw.title ||
    raw.name ||
    raw.englishTitle ||
    raw.romajiTitle ||
    raw.slug ||
    `Anime #${id}`;
  const rawPoster =
    raw.poster ||
    raw.thumbnail ||
    raw.cover ||
    raw.coverImage ||
    raw.image ||
    raw.posterUrl ||
    raw.banner ||
    raw.img ||
    '';
  const epCount = raw.episodesCount ?? raw.totalEpisodes ?? raw.episodes_count ?? raw.subCount ?? null;
  const subtitle =
    raw.subtitle ||
    (epCount ? `${epCount} eps` : raw.type || raw.year || raw.status || '');

  return {
    id: String(id),
    title: String(title),
    subtitle: subtitle ? String(subtitle) : '',
    poster: toProxiedPoster(rawPoster),
  };
}

function extractItemArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ['results', 'items', 'data', 'posts', 'anime', 'list', 'records', 'entries']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      for (const nested of ['items', 'results', 'list', 'posts', 'anime']) {
        if (Array.isArray(payload[key][nested])) return payload[key][nested];
      }
    }
  }
  return [];
}

function normalizeCatalogSections(payload, provider) {
  const sections = [];
  const pushSection = (title, rawList) => {
    const seen = new Set();
    const items = [];
    for (let i = 0; i < (rawList || []).length; i++) {
      const item = normalizeAnimeItem(rawList[i], i);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (items.length) sections.push({ title, items });
  };

  if (Array.isArray(payload?.sections)) {
    for (const sec of payload.sections) {
      pushSection(sec.title || sec.name || 'Featured', sec.posts || sec.items || sec.data || []);
    }
  } else if (Array.isArray(payload?.shelves)) {
    for (const shelf of payload.shelves) {
      pushSection(shelf.title || shelf.name || 'Featured', shelf.items || shelf.data || []);
    }
  } else if (payload && typeof payload === 'object') {
    const namedShelves = [
      ['spotlight', 'Spotlight'],
      ['trending', 'Trending Now'],
      ['popular', 'Popular'],
      ['latest', 'Latest Episodes'],
      ['recent', 'Recently Updated'],
      ['recentlyUpdated', 'Recently Updated'],
      ['airing', 'Currently Airing'],
      ['topAiring', 'Top Airing'],
      ['recommended', 'Recommended'],
    ];
    for (const [key, label] of namedShelves) {
      if (Array.isArray(payload[key]) && payload[key].length) {
        pushSection(label, payload[key]);
      }
    }
    if (!sections.length) {
      const flat = extractItemArray(payload);
      if (flat.length) pushSection('Catalog', flat);
    }
  }

  const allItems = [];
  const seenIds = new Set();
  for (const sec of sections) {
    for (const it of sec.items) {
      if (!seenIds.has(it.id)) {
        seenIds.add(it.id);
        allItems.push(it);
      }
    }
  }

  return { provider, sections, items: allItems };
}

function normalizeEpisodesPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.episodes || payload?.list || payload?.items || payload?.data || [];
  return (Array.isArray(list) ? list : [])
    .filter(Boolean)
    .map((ep, idx) => ({
      id: String(ep.id ?? ep.episodeId ?? idx + 1),
      number: ep.number ?? ep.episodeNumber ?? ep.ep ?? idx + 1,
      title: ep.title || ep.name || '',
      filler: Boolean(ep.filler),
    }));
}

function attachProxyUrlsToPlayback(proxy, result, basePath = '/api/proxy') {
  if (!result || result.status !== 'ready') return result;
  if (result.mode === 'iframe') return result;

  const primaryOriginUrl = result.streamUrl;
  const hlsToken = proxy.signTarget({
    url: result.streamUrl,
    headers: result.mediaHeaders || {},
    mirrors: result.candidateUrls || [],
    primaryOriginUrl,
    unwrapTs: Boolean(result.unwrapTs),
  });

  const subtitles = (result.subtitles || []).map((sub) => ({
    ...sub,
    proxyUrl: proxy.buildSubtitleProxyUrl(basePath, {
      url: sub.url,
      headers: result.mediaHeaders || {},
      mirrors: result.candidateUrls || [],
      primaryOriginUrl,
      unwrapTs: false,
    }),
  }));

  const spriteVttProxyUrl = result.spriteVtt
    ? proxy.buildSubtitleProxyUrl(basePath, {
        url: result.spriteVtt,
        headers: result.mediaHeaders || {},
        mirrors: result.candidateUrls || [],
        primaryOriginUrl,
        unwrapTs: false,
      })
    : null;

  return {
    ...result,
    proxyHlsUrl: `${basePath}/hls?token=${encodeURIComponent(hlsToken)}`,
    downloadUrl: `/api/download?token=${encodeURIComponent(hlsToken)}`,
    subtitles,
    spriteVttProxyUrl,
  };
}

/**
 * Create a configurable Node HTTP server for site integration or testing.
 *
 * @param {{
 *   mirudl?: MiruDLClient,
 *   anifam?: AniFamClient,
 *   proxy?: MediaProxy,
 *   publicDir?: string,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export function createAppServer(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const startedAt = Date.now();
  const stats = {
    requestsServed: 0,
    streamsResolved: 0,
    downloadsStarted: 0,
  };

  const mirudl =
    options.mirudl ||
    new MiruDLClient({
      anilabBase: process.env.MIRUDL_ANILAB_API,
      kyotoBase: process.env.MIRUDL_KYOTO_API,
      kyotoMinGapMs: process.env.MIRUDL_KYOTO_MIN_GAP_MS
        ? Number(process.env.MIRUDL_KYOTO_MIN_GAP_MS)
        : undefined,
      fetchImpl,
    });

  const anifam =
    options.anifam ||
    new AniFamClient({
      primaryApiBase: process.env.ANIFAM_PRIMARY_HOST
        ? `${process.env.ANIFAM_PRIMARY_HOST.replace(/\/+$/, '')}/api/v1/app/`
        : undefined,
      failoverDomains: process.env.ANIFAM_FAILOVER_DOMAINS
        ? process.env.ANIFAM_FAILOVER_DOMAINS.split(',')
        : undefined,
      bearerToken: process.env.ANIFAM_BEARER_TOKEN || null,
      appVersion: process.env.ANIFAM_APP_VERSION,
      appPlatform: process.env.ANIFAM_APP_PLATFORM,
      fetchImpl,
    });

  const proxy =
    options.proxy ||
    new MediaProxy({
      secret: process.env.PROXY_SECRET || 'dev-insecure-proxy-secret-change-in-prod',
      allowUnsignedDev: process.env.PROXY_ALLOW_UNSIGNED_DEV !== 'false',
      fetchImpl,
    });

  const publicDir = options.publicDir || PUBLIC_DIR;
  const cooldownBook = new SourceCooldownBook();

  const server = http.createServer(async (req, res) => {
    stats.requestsServed += 1;
    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.end();
        return;
      }

      const host = req.headers.host || 'localhost';
      const urlObj = new URL(req.url || '/', `http://${host}`);
      const pathname = urlObj.pathname;

      // Health & Keep-Alive Endpoints (support GET and HEAD for Render/uptime monitors)
      const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
      if (isGetOrHead && pathname === '/ping') {
        return sendJson(res, 200, { ok: true, ts: Date.now() }, req.method);
      }
      if (isGetOrHead && pathname === '/api/health') {
        return sendJson(
          res,
          200,
          {
            ok: true,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            startedAt: new Date(startedAt).toISOString(),
            providers: ['anifam', 'mirudl', 'demo'],
            anifamActiveOrigin: anifam.activeOrigin,
            stats: { ...stats },
          },
          req.method
        );
      }

      // ========================
      // Demo HLS Showcase Endpoints
      // ========================
      if (req.method === 'GET' && pathname === '/api/demo/catalog') {
        return sendJson(res, 200, {
          provider: 'demo',
          sections: [
            {
              title: 'Demo HLS Showcase',
              items: DEMO_ANIME.map((a) => ({
                id: a.id,
                title: a.title,
                subtitle: a.subtitle,
                poster: '',
              })),
            },
          ],
          items: DEMO_ANIME.map((a) => ({
            id: a.id,
            title: a.title,
            subtitle: a.subtitle,
            poster: '',
          })),
        });
      }
      if (req.method === 'GET' && pathname.startsWith('/api/demo/episodes/')) {
        const id = decodeURIComponent(pathname.slice('/api/demo/episodes/'.length));
        const anime = DEMO_ANIME.find((a) => a.id === id) || DEMO_ANIME[0];
        return sendJson(res, 200, {
          episodes: anime.episodes.map(({ id: epId, number, title }) => ({
            id: epId,
            number,
            title,
          })),
        });
      }
      if (req.method === 'GET' && pathname === '/api/demo/subs.vtt') {
        res.statusCode = 200;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.end(DEMO_VTT);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/demo/play') {
        const episodeId = urlObj.searchParams.get('episodeId') || 'demo-1';
        const quality = urlObj.searchParams.get('quality') || '720p';
        const ep =
          DEMO_ANIME.flatMap((a) => a.episodes).find((e) => e.id === episodeId) ||
          DEMO_ANIME[0].episodes[0];
        stats.streamsResolved += 1;
        const token = proxy.signTarget({
          url: ep.streamUrl,
          headers: { 'User-Agent': MIRUDL_CONSTANTS.HLS_UA },
          unwrapTs: false,
        });
        return sendJson(res, 200, {
          provider: 'demo',
          mode: 'hls',
          status: 'ready',
          episodeId: ep.id,
          title: ep.title,
          streamUrl: ep.streamUrl,
          proxyHlsUrl: `/api/proxy/hls?token=${encodeURIComponent(token)}`,
          downloadUrl: `/api/download?token=${encodeURIComponent(token)}&quality=${encodeURIComponent(quality)}`,
          subtitles: [
            {
              lang: 'en',
              label: 'English (Demo)',
              proxyUrl: '/api/demo/subs.vtt',
              default: true,
            },
          ],
          skip: { intro: { start: 3, end: 12 } },
          unwrapTs: false,
        });
      }

      // ========================
      // Normalized Catalog Endpoints (Frontend Convenience)
      // ========================
      if (req.method === 'GET' && pathname === '/api/catalog/home') {
        const provider = (urlObj.searchParams.get('provider') || 'anifam').toLowerCase();
        if (provider === 'demo') {
          return sendJson(res, 200, {
            provider: 'demo',
            sections: [
              {
                title: 'Demo HLS Showcase',
                items: DEMO_ANIME.map((a) => ({
                  id: a.id,
                  title: a.title,
                  subtitle: a.subtitle,
                  poster: '',
                })),
              },
            ],
            items: DEMO_ANIME.map((a) => ({
              id: a.id,
              title: a.title,
              subtitle: a.subtitle,
              poster: '',
            })),
          });
        }
        if (provider === 'mirudl') {
          const sections = await mirudl.getHomeSections();
          const enrichPool = [];
          for (const sec of sections) {
            for (const p of sec.posts || []) {
              if (!p.title && enrichPool.length < 18) enrichPool.push(p);
            }
          }
          if (enrichPool.length) {
            await mirudl.enrichTitles(enrichPool, 6).catch(() => {});
          }
          return sendJson(res, 200, normalizeCatalogSections({ sections }, 'mirudl'));
        }
        const raw = await anifam.getHome();
        return sendJson(res, 200, normalizeCatalogSections(raw, 'anifam'));
      }

      if (req.method === 'GET' && pathname === '/api/catalog/search') {
        const provider = (urlObj.searchParams.get('provider') || 'anifam').toLowerCase();
        const q = urlObj.searchParams.get('q') || '';
        const page = Number(urlObj.searchParams.get('page') || 1);
        if (provider === 'demo') {
          const filtered = DEMO_ANIME.filter((a) =>
            a.title.toLowerCase().includes(q.toLowerCase())
          );
          const list = (filtered.length ? filtered : DEMO_ANIME).map((a) => ({
            id: a.id,
            title: a.title,
            subtitle: a.subtitle,
            poster: '',
          }));
          return sendJson(res, 200, { provider: 'demo', items: list });
        }
        if (provider === 'mirudl') {
          const results = await mirudl.search(q, page);
          return sendJson(res, 200, {
            provider: 'mirudl',
            items: results.map((r, i) => normalizeAnimeItem(r, i)).filter(Boolean),
          });
        }
        const raw = await anifam.search(q, page);
        const list = extractItemArray(raw).map((r, i) => normalizeAnimeItem(r, i)).filter(Boolean);
        return sendJson(res, 200, { provider: 'anifam', items: list });
      }

      if (req.method === 'GET' && pathname === '/api/catalog/episodes') {
        const provider = (urlObj.searchParams.get('provider') || 'anifam').toLowerCase();
        const animeId = urlObj.searchParams.get('animeId') || '';
        if (!animeId) return sendJson(res, 400, { error: 'animeId is required' });
        if (provider === 'demo') {
          const anime = DEMO_ANIME.find((a) => a.id === animeId) || DEMO_ANIME[0];
          return sendJson(res, 200, {
            provider: 'demo',
            animeId: anime.id,
            episodes: anime.episodes.map(({ id, number, title }) => ({ id, number, title })),
          });
        }
        if (provider === 'mirudl') {
          const eps = await mirudl.getEpisodes(animeId);
          return sendJson(res, 200, {
            provider: 'mirudl',
            animeId,
            episodes: normalizeEpisodesPayload(eps),
          });
        }
        const raw = await anifam.getEpisodes(animeId);
        return sendJson(res, 200, {
          provider: 'anifam',
          animeId,
          episodes: normalizeEpisodesPayload(raw),
        });
      }

      // ========================
      // MiruDL REST Endpoints
      // ========================
      if (req.method === 'GET' && pathname === '/api/mirudl/home') {
        const sections = await mirudl.getHomeSections();
        if (urlObj.searchParams.get('enrich') !== '0') {
          const enrichPool = [];
          for (const sec of sections) {
            for (const p of sec.posts || []) {
              if (!p.title && enrichPool.length < 18) enrichPool.push(p);
            }
          }
          if (enrichPool.length) {
            await mirudl.enrichTitles(enrichPool, 6).catch(() => {});
          }
        }
        return sendJson(res, 200, { sections });
      }
      if (req.method === 'GET' && pathname === '/api/mirudl/categories') {
        const categories = await mirudl.getCategories();
        return sendJson(res, 200, { categories });
      }
      if (req.method === 'GET' && pathname === '/api/mirudl/search') {
        const q = urlObj.searchParams.get('q') || '';
        const page = Number(urlObj.searchParams.get('page') || 1);
        const results = await mirudl.search(q, page);
        return sendJson(res, 200, { results });
      }
      if (req.method === 'GET' && pathname.startsWith('/api/mirudl/anime/')) {
        const id = decodeURIComponent(pathname.slice('/api/mirudl/anime/'.length));
        const anime = await mirudl.getAnimeDetails(id);
        return sendJson(res, 200, { anime });
      }
      if (req.method === 'GET' && pathname.startsWith('/api/mirudl/episodes/')) {
        const id = decodeURIComponent(pathname.slice('/api/mirudl/episodes/'.length));
        const episodes = await mirudl.getEpisodes(id);
        return sendJson(res, 200, { episodes });
      }
      if (req.method === 'GET' && pathname === '/api/mirudl/play') {
        const episodeId = urlObj.searchParams.get('episodeId');
        if (!episodeId) return sendJson(res, 400, { error: 'episodeId is required' });
        const language = urlObj.searchParams.get('lang') || 'jpn';
        const preferredQuality = urlObj.searchParams.get('quality') || '1080p';
        const playback = await mirudl.resolvePlayback(episodeId, { language, preferredQuality });
        stats.streamsResolved += 1;

        const targetUrl =
          preferredQuality.toLowerCase() === 'auto' ? playback.masterUrl : playback.selectedUrl;
        const hlsToken = proxy.signTarget({
          url: targetUrl,
          headers: playback.mediaHeaders,
          unwrapTs: false,
        });
        const masterToken = proxy.signTarget({
          url: playback.masterUrl,
          headers: playback.mediaHeaders,
          unwrapTs: false,
        });

        return sendJson(res, 200, {
          ...playback,
          proxyHlsUrl: `/api/proxy/hls?token=${encodeURIComponent(masterToken)}`,
          proxySelectedHlsUrl: `/api/proxy/hls?token=${encodeURIComponent(hlsToken)}`,
          downloadUrl: `/api/download?token=${encodeURIComponent(masterToken)}&quality=${encodeURIComponent(preferredQuality)}`,
        });
      }

      // ========================
      // AniFam REST Endpoints
      // ========================
      if (req.method === 'GET' && pathname === '/api/anifam/home') {
        return sendJson(res, 200, await anifam.getHome());
      }
      if (req.method === 'GET' && pathname === '/api/anifam/search') {
        const q = urlObj.searchParams.get('q') || '';
        const page = Number(urlObj.searchParams.get('page') || 1);
        return sendJson(res, 200, await anifam.search(q, page));
      }
      if (req.method === 'GET' && pathname === '/api/anifam/browse') {
        const params = Object.fromEntries(urlObj.searchParams.entries());
        return sendJson(res, 200, await anifam.browse(params));
      }
      if (req.method === 'GET' && pathname.startsWith('/api/anifam/anime/')) {
        const id = decodeURIComponent(pathname.slice('/api/anifam/anime/'.length));
        return sendJson(res, 200, await anifam.getAnime(id));
      }
      if (req.method === 'GET' && pathname.startsWith('/api/anifam/episodes/')) {
        const id = decodeURIComponent(pathname.slice('/api/anifam/episodes/'.length));
        return sendJson(res, 200, await anifam.getEpisodes(id));
      }

      if (req.method === 'POST' && pathname === '/api/anifam/play') {
        const body = await readJsonBody(req);
        if (!body.episodeId) return sendJson(res, 400, { error: 'episodeId is required' });
        const track = body.track || 'sub';
        const playbackDto = await anifam.getPlayback(body.episodeId, track);

        const controller = new AniFamPlaybackController({
          resolveSource: (epId, serverId, t) => anifam.resolveIframeSource(epId, serverId, t),
          resolveRelativeUrl: (u) => anifam.resolveRelativeDomainUrl(u),
          cooldownBook,
          preferredServerKey: body.preferredServerKey || null,
        });

        let result;
        if (Number.isInteger(body.serverIndex)) {
          controller.episodeId = playbackDto.episodeId;
          controller.track = playbackDto.track || track;
          controller.sources = filterAndSortSources(playbackDto.sources);
          controller.servers = buildServerLabels(controller.sources);
          controller.order = computeTryOrder(
            controller.sources,
            body.preferredServerKey || null,
            cooldownBook.getActiveKeys()
          );
          result = await controller.activateSource(body.serverIndex, false);
        } else {
          result = await controller.loadPlaybackDto(playbackDto);
        }
        stats.streamsResolved += 1;

        const decorated = attachProxyUrlsToPlayback(proxy, result);
        return sendJson(res, 200, {
          ...decorated,
          episodeId: playbackDto.episodeId,
          track: playbackDto.track || track,
          tracks: playbackDto.tracks || [],
          nextEpisode: playbackDto.nextEpisode || null,
          prevEpisode: playbackDto.prevEpisode || null,
          resumePosition: playbackDto.resumePosition ?? null,
          entitlements: playbackDto.entitlements || null,
          rawSources: controller.sources.map((s, idx) => ({
            index: idx,
            kind: s.kind,
            serverId: s.serverId ?? null,
            isResolvableIframe: isResolvableIframe(s),
            isWebEmbed: isWebEmbedIframe(s),
            embedUrl: s.embedUrl ? anifam.resolveRelativeDomainUrl(s.embedUrl) : null,
            url: s.kind === 'hls' ? s.url : isWebEmbedIframe(s) ? s.url : null,
          })),
        });
      }

      if (req.method === 'POST' && pathname === '/api/anifam/resolve') {
        const body = await readJsonBody(req);
        if (!body.episodeId || body.serverId === undefined) {
          return sendJson(res, 400, { error: 'episodeId and serverId are required' });
        }
        const track = body.track || 'sub';
        const resolved = await anifam.resolveIframeSource(body.episodeId, body.serverId, track);
        const candidateUrls = collectCandidateUrls(resolved);
        stats.streamsResolved += 1;
        const payload = attachProxyUrlsToPlayback(proxy, {
          status: 'ready',
          mode: 'resolved_hls',
          streamUrl: candidateUrls[0],
          candidateUrls,
          mediaHeaders: resolved.mediaHeaders || {},
          qualities: resolved.qualities || [],
          subtitles: resolved.subtitles || [],
          spriteVtt: resolved.spriteVtt || null,
          thumb: resolved.thumb || null,
          skip: resolved.skip || null,
          duration: resolved.duration ?? null,
          unwrapTs: true,
        });
        return sendJson(res, 200, payload);
      }

      if (req.method === 'POST' && pathname === '/api/anifam/download-grant') {
        const body = await readJsonBody(req);
        if (!body.episodeId) return sendJson(res, 400, { error: 'episodeId is required' });
        const { grant, source } = await anifam.requestDownloadGrant(body.episodeId, {
          track: body.track || 'sub',
          quality: body.quality || '1080p',
        });
        if (!source) {
          return sendJson(res, 404, { error: 'No downloadable HLS source returned', grant });
        }
        const candidateUrls = collectCandidateUrls(source);
        const dlToken = proxy.signTarget({
          url: candidateUrls[0],
          headers: source.mediaHeaders || {},
          mirrors: candidateUrls,
          primaryOriginUrl: candidateUrls[0],
          unwrapTs: false,
        });
        return sendJson(res, 200, {
          grant,
          source,
          downloadUrl: `/api/download?token=${encodeURIComponent(dlToken)}&quality=${encodeURIComponent(body.quality || '1080p')}`,
        });
      }

      if (req.method === 'POST' && pathname === '/api/anifam/cast') {
        const body = await readJsonBody(req);
        if (!body.episodeId || !body.url) {
          return sendJson(res, 400, { error: 'episodeId and url are required' });
        }
        return sendJson(res, 200, await anifam.requestCastUrls(body.episodeId, body));
      }

      // ========================
      // Media & Image Proxy Endpoints
      // ========================
      if (req.method === 'POST' && pathname === '/api/proxy/sign') {
        const body = await readJsonBody(req);
        if (!body.url) return sendJson(res, 400, { error: 'url is required' });
        const token = proxy.signTarget({
          url: body.url,
          headers: body.headers || {},
          mirrors: body.mirrors || [],
          unwrapTs: Boolean(body.unwrapTs),
        });
        return sendJson(res, 200, {
          token,
          proxyHlsUrl: `/api/proxy/hls?token=${encodeURIComponent(token)}`,
          proxySegmentUrl: `/api/proxy/segment?token=${encodeURIComponent(token)}`,
          downloadUrl: `/api/download?token=${encodeURIComponent(token)}`,
        });
      }

      if (req.method === 'GET' && pathname === '/api/proxy/image') {
        const targetUrl = urlObj.searchParams.get('url');
        if (!isSafePublicHttpsUrl(targetUrl)) {
          return sendJson(res, 400, { error: 'Invalid or disallowed image URL' });
        }
        const upstream = await fetchImpl(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent': MIRUDL_CONSTANTS.ANILAB_UA,
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
        });
        if (!upstream.ok) {
          return sendJson(res, upstream.status, { error: `Image upstream HTTP ${upstream.status}` });
        }
        const ct = upstream.headers.get('content-type') || 'image/jpeg';
        if (!ct.toLowerCase().startsWith('image/')) {
          return sendJson(res, 415, { error: 'Upstream URL did not return an image' });
        }
        res.statusCode = 200;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const bodyStream = upstream.body ? Readable.fromWeb(upstream.body) : Readable.from(Buffer.alloc(0));
        await pipeline(bodyStream, res);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/proxy/hls') {
        await proxy.handleHlsRequest(req, res, urlObj, '/api/proxy');
        return;
      }
      if (req.method === 'GET' && pathname === '/api/proxy/segment') {
        await proxy.handleSegmentRequest(req, res, urlObj);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/proxy/subtitle') {
        await proxy.handleSubtitleRequest(req, res, urlObj);
        return;
      }

      // ========================
      // Streaming Download Endpoint
      // ========================
      if (req.method === 'GET' && pathname === '/api/download') {
        const quality = urlObj.searchParams.get('quality') || '1080p';
        const concurrency = Number(urlObj.searchParams.get('concurrency') || 16);
        const rawTitle = urlObj.searchParams.get('title') || 'episode';
        const safeTitle = sanitizeFilename(rawTitle);

        let playlistUrl = null;
        let headers = {};
        let mirrorUrls = [];
        let unwrapTs = false;

        const token = urlObj.searchParams.get('token');
        if (token) {
          const verified = proxy.verifyToken(token);
          playlistUrl = verified.url;
          headers = verified.headers || {};
          mirrorUrls = verified.mirrors || [];
          unwrapTs = Boolean(verified.unwrapTs);
        } else {
          const provider = urlObj.searchParams.get('provider');
          const episodeId = urlObj.searchParams.get('episodeId');
          if (provider === 'mirudl' && episodeId) {
            const lang = urlObj.searchParams.get('lang') || 'jpn';
            const pb = await mirudl.resolvePlayback(episodeId, {
              language: lang,
              preferredQuality: quality,
            });
            playlistUrl = pb.masterUrl;
            headers = pb.mediaHeaders;
          } else if (provider === 'anifam' && episodeId) {
            const track = urlObj.searchParams.get('track') || 'sub';
            const serverId = urlObj.searchParams.get('serverId');
            if (serverId) {
              const resolved = await anifam.resolveIframeSource(episodeId, serverId, track);
              mirrorUrls = collectCandidateUrls(resolved);
              playlistUrl = mirrorUrls[0];
              headers = resolved.mediaHeaders || {};
              unwrapTs = true;
            } else {
              const { source } = await anifam.requestDownloadGrant(episodeId, { track, quality });
              if (!source) return sendJson(res, 404, { error: 'No downloadable source returned' });
              mirrorUrls = collectCandidateUrls(source);
              playlistUrl = mirrorUrls[0];
              headers = source.mediaHeaders || {};
              unwrapTs = false;
            }
          } else if (provider === 'demo') {
            const ep =
              DEMO_ANIME.flatMap((a) => a.episodes).find((e) => e.id === episodeId) ||
              DEMO_ANIME[0].episodes[0];
            playlistUrl = ep.streamUrl;
            headers = { 'User-Agent': MIRUDL_CONSTANTS.HLS_UA };
          } else if (proxy.allowUnsignedDev && urlObj.searchParams.get('url')) {
            playlistUrl = urlObj.searchParams.get('url');
            unwrapTs = urlObj.searchParams.get('unwrapTs') === '1';
            if (urlObj.searchParams.get('referer')) {
              headers.Referer = urlObj.searchParams.get('referer');
            }
            if (!headers['User-Agent']) {
              headers['User-Agent'] = MIRUDL_CONSTANTS.HLS_UA;
            }
          }
        }

        if (!playlistUrl) {
          return sendJson(res, 400, {
            error: 'Provide a signed token, or provider+episodeId, or (in dev) url',
          });
        }

        stats.downloadsStarted += 1;
        const abortController = new AbortController();
        req.on('close', () => abortController.abort());

        const { stream, meta, done } = await createHlsDownloadStream({
          playlistUrl,
          preferredQuality: quality,
          headers,
          mirrorUrls,
          concurrency,
          unwrapTs,
          fetchImpl,
          signal: abortController.signal,
        });

        const filename = `${safeTitle}-${sanitizeFilename(meta.selectedQuality)}.mp4`;
        res.statusCode = 200;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('X-Selected-Quality', meta.selectedQuality || 'Auto');
        res.setHeader('X-Total-Segments', String(meta.segments.length));
        res.setHeader('Cache-Control', 'no-store');

        await Promise.all([pipeline(stream, res), done]);
        return;
      }

      // ========================
      // Static Web Frontend
      // ========================
      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const resolvedPath = path.resolve(publicDir, rel);
        if (!resolvedPath.startsWith(publicDir + path.sep) && resolvedPath !== publicDir) {
          return sendJson(res, 403, { error: 'Forbidden' }, req.method);
        }
        try {
          const stat = await fs.stat(resolvedPath);
          if (stat.isFile()) {
            const ext = path.extname(resolvedPath).toLowerCase();
            res.statusCode = 200;
            res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
            res.setHeader('Content-Length', String(stat.size));
            if (req.method === 'HEAD') {
              res.end();
              return;
            }
            res.end(await fs.readFile(resolvedPath));
            return;
          }
        } catch {
          // fall through to 404
        }
      }

      sendJson(res, 404, { error: `Not found: ${req.method} ${pathname}` });
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      const status = err instanceof AniFamApiError ? err.status : 500;
      sendJson(res, status, {
        error: err?.message || 'Internal Server Error',
        status,
      });
    }
  });

  return { server, mirudl, anifam, proxy };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const { server } = createAppServer();
  server.listen(port, host, () => {
    console.log(`Anime Stream & Download SDK listening at http://${host}:${port}`);
    const keepAliveTarget = process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL;
    if (process.env.ENABLE_KEEPALIVE === 'true' && keepAliveTarget) {
      const intervalMs = Number(process.env.SELF_PING_INTERVAL_MS || 14 * 60 * 1000);
      const pingUrl = `${keepAliveTarget.replace(/\/+$/, '')}/ping`;
      const timer = setInterval(() => {
        fetch(pingUrl).catch(() => {});
      }, intervalMs);
      timer.unref();
    }
  });
}
