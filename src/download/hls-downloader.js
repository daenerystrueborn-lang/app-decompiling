/**
 * Concurrent HLS Episode Downloader (File + Direct HTTP Stream)
 *
 * Combines:
 *  - MiruDL's `HlsDownloader` (1..64 threads, 3 retries w/ backoff, `#EXT-X-MAP`,
 *    `#EXT-X-KEY` rejection, `.part` -> `.mp4` atomic finalize, EMA speed tracking)
 *  - Fixed `preferredQuality` selection (resolves MiruDL's `DownloadService.runSingleJob` bug
 *    where `preferred_quality` was discarded in favor of `pickBestVariant`)
 *  - AniFam's `TsUnwrapper` (`Q7/n` / `Q7/m`) for iframe-resolved disguised-image `.ts` segments
 *  - Direct HTTP streaming output (`streamHlsDownload`) so a website backend can pipe an
 *    assembled episode directly to the user's browser without permanent server disk storage.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickVariantByQuality,
} from '../utils/hls-parser.js';
import { unwrapTsBuffer } from '../utils/ts-unwrapper.js';

export function clampConcurrency(n) {
  const num = Number.parseInt(String(n ?? 16), 10);
  if (!Number.isFinite(num) || num < 1) return 1;
  return Math.min(num, 64);
}

export function sanitizeFilename(name) {
  if (!name || !String(name).trim()) return 'Unknown';
  let clean = String(name)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length > 80) clean = clean.slice(0, 80).trim();
  return clean || 'Unknown';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(url, headers, fetchImpl, signal, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw new Error('Download cancelled by user');
    }
    try {
      const res = await fetchImpl(url, { method: 'GET', headers, signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      if (buf.length === 0) {
        throw new Error(`Empty response body from ${url}`);
      }
      return buf;
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        throw new Error('Download cancelled by user');
      }
      lastErr = err;
      if (attempt < retries) {
        await sleep(attempt * 500);
      }
    }
  }
  throw lastErr || new Error(`Failed fetching ${url}`);
}

/**
 * Resolve a master/media HLS URL to concrete media playlist segments + selected quality.
 *
 * @param {string} playlistUrl
 * @param {{
 *   preferredQuality?: string,
 *   headers?: Record<string, string>,
 *   mirrorUrls?: string[],
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function resolveHlsMedia(playlistUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const headers = options.headers || {};
  const candidates = [playlistUrl, ...(options.mirrorUrls || [])].filter(Boolean);

  let activeMasterUrl = null;
  let rootText = null;
  let lastErr = null;

  for (const candidate of candidates) {
    try {
      const buf = await fetchWithRetries(candidate, headers, fetchImpl, options.signal, 2);
      rootText = buf.toString('utf8');
      activeMasterUrl = candidate;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!rootText || !activeMasterUrl) {
    throw lastErr || new Error('Failed to load HLS playlist');
  }

  let mediaUrl = activeMasterUrl;
  let mediaText = rootText;
  let selectedQuality = 'Auto';
  let availableVariants = [];

  if (rootText.includes('#EXT-X-STREAM-INF')) {
    const master = parseMasterPlaylist(rootText, activeMasterUrl);
    availableVariants = master.variants;
    const chosen = pickVariantByQuality(
      master.variants,
      options.preferredQuality || 'highest'
    );
    if (chosen) {
      mediaUrl = chosen.url;
      selectedQuality = chosen.quality || chosen.label || 'Auto';
      const subBuf = await fetchWithRetries(mediaUrl, headers, fetchImpl, options.signal, 3);
      mediaText = subBuf.toString('utf8');
    }
  }

  const parsed = parseMediaPlaylist(mediaText, mediaUrl);
  if (parsed.encrypted) {
    throw new Error('Encrypted streams (#EXT-X-KEY) are not supported');
  }
  if (!parsed.segments.length) {
    throw new Error('No HLS segments found in playlist');
  }

  return {
    masterUrl: activeMasterUrl,
    mediaUrl,
    selectedQuality,
    availableVariants,
    initMapUrl: parsed.initMapUrl,
    segments: parsed.segments,
  };
}

/**
 * Core concurrent segment fetcher that invokes `onChunk` in exact segment sequence order
 * (or buffers out-of-order completed segments until contiguous in sequence order, keeping memory bounded).
 *
 * @param {string} playlistUrl
 * @param {{
 *   preferredQuality?: string,
 *   headers?: Record<string, string>,
 *   mirrorUrls?: string[],
 *   concurrency?: number,
 *   unwrapTs?: boolean,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   onResolved?: (meta: any) => void,
 *   onProgress?: (info: { percent: number, completedSegments: number, totalSegments: number, bytesDownloaded: number, speedBytesPerSec: number }) => void,
 *   writeChunk: (buf: Buffer) => Promise<void> | void,
 * }} options
 */
async function executeConcurrentHlsPipeline(playlistUrl, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const headers = options.headers || {};
  const concurrency = clampConcurrency(options.concurrency ?? 16);
  const unwrapTs = Boolean(options.unwrapTs);

  const resolved = await resolveHlsMedia(playlistUrl, {
    preferredQuality: options.preferredQuality,
    headers,
    mirrorUrls: options.mirrorUrls,
    fetchImpl,
    signal: options.signal,
  });

  if (options.onResolved) {
    options.onResolved(resolved);
  }

  let bytesWritten = 0;

  if (resolved.initMapUrl) {
    const initBuf = await fetchWithRetries(
      resolved.initMapUrl,
      headers,
      fetchImpl,
      options.signal,
      3
    );
    await options.writeChunk(initBuf);
    bytesWritten += initBuf.length;
  }

  const total = resolved.segments.length;
  const readyBuffers = new Map();
  let nextToWrite = 0;
  let nextToFetch = 0;
  let completed = 0;
  let bytesFetched = 0;
  let lastTickTime = Date.now();
  let lastTickBytes = 0;
  let emaSpeed = -1;

  // Serialize in-order flushing
  let flushChain = Promise.resolve();
  const scheduleFlush = () => {
    flushChain = flushChain.then(async () => {
      while (readyBuffers.has(nextToWrite)) {
        const buf = readyBuffers.get(nextToWrite);
        readyBuffers.delete(nextToWrite);
        await options.writeChunk(buf);
        bytesWritten += buf.length;
        nextToWrite += 1;
      }
    });
    return flushChain;
  };

  const progressTimer = options.onProgress
    ? setInterval(() => {
        const now = Date.now();
        const dt = now - lastTickTime;
        const db = bytesFetched - lastTickBytes;
        lastTickTime = now;
        lastTickBytes = bytesFetched;
        if (dt > 0) {
          const instant = (db * 1000) / dt;
          emaSpeed = emaSpeed < 0 ? instant : instant * 0.3 + emaSpeed * 0.7;
        }
        options.onProgress({
          percent: Math.floor((completed * 100) / total),
          completedSegments: completed,
          totalSegments: total,
          bytesDownloaded: bytesFetched,
          speedBytesPerSec: Math.round(Math.max(0, emaSpeed)),
        });
      }, 700)
    : null;

  try {
    const workerCount = Math.min(concurrency, total);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (options.signal?.aborted) {
          throw new Error('Download cancelled by user');
        }
        const idx = nextToFetch++;
        if (idx >= total) break;

        const seg = resolved.segments[idx];
        let segBuf = await fetchWithRetries(seg.url, headers, fetchImpl, options.signal, 3);
        if (unwrapTs) {
          segBuf = unwrapTsBuffer(segBuf).data;
        }
        bytesFetched += segBuf.length;
        completed += 1;
        readyBuffers.set(idx, segBuf);
        await scheduleFlush();
      }
    });

    await Promise.all(workers);
    await flushChain;

    if (options.onProgress) {
      options.onProgress({
        percent: 100,
        completedSegments: total,
        totalSegments: total,
        bytesDownloaded: bytesFetched,
        speedBytesPerSec: 0,
      });
    }

    return {
      ...resolved,
      bytesWritten,
      segmentsDownloaded: total,
    };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

/**
 * Download an HLS stream to disk (`<outputDir>/<anime>/<episode>.mp4`), matching MiruDL's `.part`
 * staging + atomic rename.
 *
 * @param {{
 *   playlistUrl: string,
 *   outputPath: string,
 *   preferredQuality?: string,
 *   headers?: Record<string, string>,
 *   mirrorUrls?: string[],
 *   concurrency?: number,
 *   unwrapTs?: boolean,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   onProgress?: Function,
 * }} options
 */
export async function downloadHlsToFile(options) {
  const outputPath = path.resolve(options.outputPath);
  const partPath = `${outputPath}.part`;
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const ws = fs.createWriteStream(partPath);

  const writeChunk = (buf) =>
    new Promise((resolve, reject) => {
      if (!ws.write(buf)) {
        ws.once('drain', resolve);
      } else {
        resolve();
      }
      ws.once('error', reject);
    });

  try {
    const result = await executeConcurrentHlsPipeline(options.playlistUrl, {
      ...options,
      writeChunk,
    });
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });
    await fsp.rename(partPath, outputPath);
    return { ...result, outputPath };
  } catch (err) {
    ws.destroy();
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Stream an assembled HLS download through a Node `PassThrough` stream
 * so an HTTP endpoint can pipe the episode directly to a browser `<a download>`.
 *
 * @param {{
 *   playlistUrl: string,
 *   preferredQuality?: string,
 *   headers?: Record<string, string>,
 *   mirrorUrls?: string[],
 *   concurrency?: number,
 *   unwrapTs?: boolean,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ stream: PassThrough, meta: any, done: Promise<any> }>}
 */
export async function createHlsDownloadStream(options) {
  const passThrough = new PassThrough();
  const controller = new AbortController();

  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  passThrough.on('close', () => {
    if (!passThrough.writableEnded) controller.abort();
  });

  // Pre-resolve metadata before starting segment stream so HTTP response headers can be set!
  const meta = await resolveHlsMedia(options.playlistUrl, {
    preferredQuality: options.preferredQuality,
    headers: options.headers,
    mirrorUrls: options.mirrorUrls,
    fetchImpl: options.fetchImpl,
    signal: controller.signal,
  });

  const done = (async () => {
    try {
      const result = await executeConcurrentHlsPipeline(meta.mediaUrl, {
        ...options,
        preferredQuality: 'auto', // already resolved above
        signal: controller.signal,
        writeChunk: (buf) =>
          new Promise((resolve, reject) => {
            if (passThrough.destroyed) {
              reject(new Error('Stream closed'));
              return;
            }
            if (!passThrough.write(buf)) {
              passThrough.once('drain', resolve);
            } else {
              resolve();
            }
          }),
      });
      passThrough.end();
      return result;
    } catch (err) {
      passThrough.destroy(err);
      throw err;
    }
  })();

  return { stream: passThrough, meta, done };
}
