/**
 * Unified Node HTTP Integration Server
 *
 * Exposes MiruDL + AniFam catalog, playback, 3-mode resolver, signed HLS/segment proxy
 * (with real-time AniFam TS image-header unwrapping), concurrent HLS streaming downloads,
 * and static web frontend demo under `public/`.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

      // Healthcheck
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          providers: ['mirudl', 'anifam'],
          anifamActiveOrigin: anifam.activeOrigin,
        });
      }

      // ========================
      // MiruDL REST Endpoints
      // ========================
      if (req.method === 'GET' && pathname === '/api/mirudl/home') {
        const sections = await mirudl.getHomeSections();
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
          // Initialize lists first, then jump to requested server index
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

        // Attach signed proxy URLs to every server so the browser can switch or fall back cleanly
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
      // Media Proxy Endpoints
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
      if (req.method === 'GET') {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const resolvedPath = path.resolve(publicDir, rel);
        if (!resolvedPath.startsWith(publicDir + path.sep) && resolvedPath !== publicDir) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        try {
          const stat = await fs.stat(resolvedPath);
          if (stat.isFile()) {
            const ext = path.extname(resolvedPath).toLowerCase();
            res.statusCode = 200;
            res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
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
  });
}
