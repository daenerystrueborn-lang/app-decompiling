import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  MiruDLClient,
  AniFamClient,
  AniFamApiError,
  AniFamPlaybackController,
  SourceCooldownBook,
  MediaProxy,
  TsUnwrapperTransform,
  createAppServer,
  createHlsDownloadStream,
  decodeMiruBaseUrl,
  deriveKyotoInnerKey,
  downloadHlsToFile,
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickVariantByQuality,
  rewriteAssetOriginForMirror,
  rewriteHlsPlaylist,
  signKyotoRequest,
  unwrapTsBuffer,
} from '../src/index.js';

function makeValidTsChunk(packetCount = 4, fillBase = 0x10) {
  const buf = Buffer.alloc(packetCount * 188);
  for (let p = 0; p < packetCount; p++) {
    const off = p * 188;
    buf[off] = 0x47;
    buf.fill((fillBase + p) & 0xff, off + 1, off + 188);
  }
  return buf;
}

function makeFakeResponse(body, { status = 200, headers = {} } = {}) {
  const hdrs = new Headers(headers);
  if (
    typeof body !== 'string' &&
    !Buffer.isBuffer(body) &&
    !hdrs.has('content-type')
  ) {
    hdrs.set('content-type', 'application/json');
  }
  const bytes =
    typeof body === 'string'
      ? Buffer.from(body, 'utf8')
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(JSON.stringify(body), 'utf8');

  return new Response(bytes, { status, headers: hdrs });
}

test('MiruDL base decode, Kyoto key derivation, and request signing', () => {
  assert.equal(decodeMiruBaseUrl(), 'https://anidb.app');

  const innerKey = deriveKyotoInnerKey();
  assert.equal(innerKey.length, 32);

  const signed = signKyotoRequest('/stream?id=99&server=99/jpn', {
    timestampSec: 1700000000,
    nonce: 'fixed-nonce-value',
  });
  assert.equal(signed.headers['app-id'], 'com.kyotoplayer');
  assert.equal(signed.headers['app-version'], '132');
  assert.equal(signed.headers['X-Kyoto-Ts'], '1700000000');
  assert.equal(signed.headers['X-Kyoto-Nonce'], 'fixed-nonce-value');
  assert.ok(signed.canonical.includes('\n/stream\n'));
  assert.ok(!signed.canonical.includes('server=99'));
  assert.match(signed.signature, /^[0-9a-f]{64}$/);
});

test('MiruDLClient catalog enrichment, 401/429 retry, and preferredQuality fix', async () => {
  let kyotoAttempts = 0;
  const masterM3u8 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1920x1080',
    '1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=854x480',
    '480/index.m3u8',
  ].join('\n');

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('anilab2.amdapi.click/api/search')) {
      return makeFakeResponse({
        posts: [
          { id: 'a1', title: '', poster: 'https://cdn.example/p1.jpg' },
          { id: 'a2', title: 'Frieren', poster: 'https://cdn.example/p2.jpg' },
        ],
      });
    }
    if (u.includes('anilab2.amdapi.click/api/post?id=a1')) {
      return makeFakeResponse({ id: 'a1', title: 'Solo Leveling' });
    }
    if (u.includes('api.kyotoplayer.com/servers')) {
      assert.equal(init.method, 'POST');
      assert.ok(init.headers['X-Kyoto-Sig']);
      return makeFakeResponse({
        list: [{ id: '99/jpn', name: 'Server 1', lang: 'jpn' }],
      });
    }
    if (u.includes('api.kyotoplayer.com/stream')) {
      kyotoAttempts += 1;
      if (kyotoAttempts === 1) {
        return makeFakeResponse({ error: 'rate limited' }, { status: 429 });
      }
      return makeFakeResponse({
        link: 'https://cdn.kyoto.test/ep99/master.m3u8',
      });
    }
    if (u === 'https://cdn.kyoto.test/ep99/master.m3u8') {
      assert.equal(init.headers.Referer, 'https://play.app/');
      return makeFakeResponse(masterM3u8, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    }
    throw new Error(`Unexpected URL in mockFetch: ${u}`);
  };

  const client = new MiruDLClient({
    kyotoMinGapMs: 5,
    kyotoRetryDelaysMs: [5, 10],
    fetchImpl: mockFetch,
  });

  const searchRes = await client.search('solo');
  assert.equal(searchRes[0].title, 'Solo Leveling');
  assert.equal(searchRes[1].title, 'Frieren');

  const playback = await client.resolvePlayback('99', {
    language: 'jpn',
    preferredQuality: '720p',
  });
  assert.equal(kyotoAttempts, 2);
  assert.equal(playback.selectedQuality, '720p');
  assert.equal(playback.selectedUrl, 'https://cdn.kyoto.test/ep99/720/index.m3u8');
  assert.equal(playback.mediaHeaders.Referer, 'https://play.app/');
});

test('TS Unwrapper strips PNG/JPEG/GIF8/RIFF/BMP prefixes and works across split stream chunks', async () => {
  const validTs = makeValidTsChunk(4, 0x22);

  const prefixes = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), // PNG
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), // JPEG
    Buffer.from('GIF89a\x01\x00\x01\x00'), // GIF8
    Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 '), // RIFF
    Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]), // BMP
  ];

  for (const prefix of prefixes) {
    const disguised = Buffer.concat([prefix, validTs]);
    const res = unwrapTsBuffer(disguised);
    assert.equal(res.strippedBytes, prefix.length);
    assert.ok(Buffer.from(res.data).equals(validTs));
  }

  // Clean TS stays unchanged
  const cleanRes = unwrapTsBuffer(validTs);
  assert.equal(cleanRes.strippedBytes, 0);
  assert.ok(Buffer.from(cleanRes.data).equals(validTs));

  // Streaming transform across tiny fragmented chunks
  const pngPrefix = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const fullDisguised = Buffer.concat([pngPrefix, validTs]);
  const smallChunks = [];
  for (let i = 0; i < fullDisguised.length; i += 7) {
    smallChunks.push(fullDisguised.subarray(i, i + 7));
  }

  let detected = null;
  const tx = new TsUnwrapperTransform({
    enabled: true,
    onUnwrapped: (info) => {
      detected = info;
    },
  });

  const outChunks = [];
  await new Promise((resolve, reject) => {
    tx.on('data', (c) => outChunks.push(c));
    tx.on('error', reject);
    tx.on('end', resolve);
    Readable.from(smallChunks).pipe(tx);
  });

  const output = Buffer.concat(outChunks);
  assert.equal(detected.signature, 'PNG');
  assert.equal(detected.strippedBytes, pngPrefix.length);
  assert.ok(output.equals(validTs));
});

test('HLS parser + quality scorer + playlist rewriter', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",URI="audio/jpn.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="aud"',
    'v1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,AUDIO="aud"',
    'v720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,AUDIO="aud"',
    'v360.m3u8',
  ].join('\n');

  const parsedMaster = parseMasterPlaylist(master, 'https://cdn.test/anime/master.m3u8');
  assert.equal(parsedMaster.variants.length, 3);
  assert.equal(pickVariantByQuality(parsedMaster.variants, '720p').quality, '720p');
  assert.equal(pickVariantByQuality(parsedMaster.variants, '480p').quality, '360p'); // nearest <= 480
  assert.equal(pickVariantByQuality(parsedMaster.variants, 'lowest').quality, '360p');
  assert.equal(pickVariantByQuality(parsedMaster.variants, 'highest').quality, '1080p');

  const rewrittenMaster = rewriteHlsPlaylist(master, 'https://cdn.test/anime/master.m3u8', {
    rewritePlaylistUrl: (u) => `/proxy/hls?u=${encodeURIComponent(u)}`,
    rewriteSegmentUrl: (u) => `/proxy/seg?u=${encodeURIComponent(u)}`,
  });
  assert.ok(rewrittenMaster.includes('/proxy/hls?u=https%3A%2F%2Fcdn.test%2Fanime%2Faudio%2Fjpn.m3u8'));
  assert.ok(rewrittenMaster.includes('/proxy/hls?u=https%3A%2F%2Fcdn.test%2Fanime%2Fv1080.m3u8'));

  const encryptedMedia = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg0.ts\n';
  assert.equal(parseMediaPlaylist(encryptedMedia, 'https://cdn.test/v720.m3u8').encrypted, true);
});

test('AniFamClient multi-domain failover, Bearer host isolation, and 429 Retry-After', async () => {
  const calls = [];
  let retryCount = 0;

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers });
    if (u.startsWith('https://app.anifam.net/api/v1/app/home')) {
      return makeFakeResponse({ error: 'bad gateway' }, { status: 502 });
    }
    if (u.startsWith('https://anifam.net/api/v1/app/home')) {
      retryCount += 1;
      if (retryCount === 1) {
        return makeFakeResponse({ error: 'slow down' }, { status: 429, headers: { 'Retry-After': '0' } });
      }
      return makeFakeResponse({ shelves: [{ title: 'Trending', items: [] }] });
    }
    return makeFakeResponse({ ok: true });
  };

  const client = new AniFamClient({
    bearerToken: 'secret-jwt',
    fetchImpl: mockFetch,
  });

  const home = await client.getHome();
  assert.equal(home.shelves[0].title, 'Trending');
  assert.equal(client.activeOrigin, 'https://anifam.net');

  // Bearer token sent ONLY to app.anifam.net, NOT to failover host anifam.net
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-jwt');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[0].headers['X-App-Version'], '20');
  assert.equal(calls[0].headers['X-App-Platform'], 'android');
});

test('AniFamPlaybackController 3-mode playback, mirror rewrite, 5m cooldown & 403 wall', async () => {
  let nowMs = 1_000_000;
  const cooldownBook = new SourceCooldownBook(() => nowMs);
  const controller = new AniFamPlaybackController({
    resolveRelativeUrl: (u) => (u?.startsWith('/') ? `https://app.anifam.net${u}` : u),
    cooldownBook,
    resolveSource: async (_epId, serverId) => ({
      kind: 'hls',
      serverId,
      url: 'https://cdn1.example/stream/playlist.m3u8',
      mirrors: ['https://cdn2.example/mirror/playlist.m3u8'],
      mediaHeaders: { Referer: 'https://megaplay.buzz/' },
      subtitles: [{ lang: 'en', url: 'https://cdn1.example/subs/en.vtt' }],
      skip: { intro: { start: 90, end: 180 } },
    }),
  });

  const playbackDto = {
    episodeId: 77,
    track: 'sub',
    tracks: ['sub', 'dub'],
    sources: [
      { kind: 'iframe', serverId: 20, resolvable: true, backup: true },
      {
        kind: 'hls',
        serverId: 10,
        url: 'https://primary.example/ep77/master.m3u8',
        mirrors: ['https://mirror.example/ep77/master.m3u8'],
        mediaHeaders: { Origin: 'https://anifam.net' },
        subtitles: [{ lang: 'en', url: 'https://primary.example/ep77/subs.vtt' }],
        backup: false,
      },
      { kind: 'iframe', embedUrl: '/embed/77', resolvable: false, backup: true },
    ],
  };

  // Mode 1: Direct HLS starts first (sorted before iframes); V1.h tries [...mirrors, url]
  const s1 = await controller.loadPlaybackDto(playbackDto);
  assert.equal(s1.mode, 'hls');
  assert.equal(s1.unwrapTs, false);
  assert.equal(s1.server.label, 'AniFam');
  assert.equal(s1.streamUrl, 'https://mirror.example/ep77/master.m3u8');
  assert.equal(s1.servers[2].isWebOnly, true);

  // Playback error 1 rotates from mirrors[0] to primary fallback url + rewrites subtitle origin (V1.j)
  const err1 = await controller.handlePlaybackError();
  assert.equal(err1.status, 'mirror_switch');
  assert.equal(err1.streamUrl, 'https://primary.example/ep77/master.m3u8');
  assert.equal(
    err1.rewriteSubtitleUrl('https://mirror.example/ep77/subs.vtt'),
    'https://primary.example/ep77/subs.vtt'
  );

  // Exhausting mirrors puts Source 0 (kind === 'hls' -> 'main' per V1.e) on 5-min cooldown and transitions to Mode 2 (resolved_hls!)
  const s2 = await controller.handlePlaybackError();
  assert.equal(s2.mode, 'resolved_hls');
  assert.equal(s2.unwrapTs, true);
  assert.equal(s2.isFallback, true);
  assert.ok(cooldownBook.getActiveKeys().has('main'));

  // Exhausting mirrors on Mode 2 triggers 1x HLS retry (`!this.hlsRetried` per O7/J1.i),
  // then exhausting HLS retry falls through to Mode 3 (`iframe` embed)
  const s2Err1 = await controller.handlePlaybackError();
  assert.equal(s2Err1.status, 'mirror_switch');
  assert.equal(s2Err1.streamUrl, 'https://cdn1.example/stream/playlist.m3u8');

  const hlsRetry = await controller.handlePlaybackError();
  assert.equal(hlsRetry.mode, 'hls');
  assert.equal(hlsRetry.isFallback, true);

  const retryMirror = await controller.handlePlaybackError();
  assert.equal(retryMirror.status, 'mirror_switch');

  const s3 = await controller.handlePlaybackError();
  assert.equal(s3.mode, 'iframe');
  assert.equal(s3.embedUrl, 'https://app.anifam.net/embed/77');

  // Advancing 5 minutes clears cooldown
  nowMs += 301_000;
  assert.equal(cooldownBook.getActiveKeys().size, 0);

  // 403 triggers entitlement_required immediately
  const wallController = new AniFamPlaybackController({
    resolveSource: async () => {
      throw new AniFamApiError(403, 'Subscription required');
    },
  });
  const wallState = await wallController.loadPlaybackDto({
    episodeId: 88,
    track: 'sub',
    sources: [{ kind: 'iframe', serverId: 5, resolvable: true }],
  });
  assert.equal(wallState.status, 'entitlement_required');
});

test('downloadHlsToFile downloads #EXT-X-MAP + PNG-disguised segments in order and cleans .part', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anime-sdk-dl-'));
  const initBytes = Buffer.from('FTYP_INIT_MAP_BYTES');
  const seg0Ts = makeValidTsChunk(3, 0x31);
  const seg1Ts = makeValidTsChunk(3, 0x41);
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
    '1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480',
    '480.m3u8',
  ].join('\n');

  const media480 = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg0.png',
    '#EXTINF:4.0,',
    'seg1.png',
    '#EXT-X-ENDLIST',
  ].join('\n');

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/master.m3u8')) return makeFakeResponse(master);
    if (u.endsWith('/480.m3u8')) return makeFakeResponse(media480);
    if (u.endsWith('/init.mp4')) return makeFakeResponse(initBytes);
    if (u.endsWith('/seg0.png')) return makeFakeResponse(Buffer.concat([pngHeader, seg0Ts]));
    if (u.endsWith('/seg1.png')) return makeFakeResponse(Buffer.concat([pngHeader, seg1Ts]));
    throw new Error(`Unexpected URL: ${u}`);
  };

  const outFile = path.join(tmpDir, 'Anime', 'Episode 01.mp4');
  const result = await downloadHlsToFile({
    playlistUrl: 'https://cdn.test/master.m3u8',
    outputPath: outFile,
    preferredQuality: '480p',
    concurrency: 4,
    unwrapTs: true,
    fetchImpl: mockFetch,
  });

  assert.equal(result.selectedQuality, '480p');
  const written = await fsp.readFile(outFile);
  assert.ok(written.equals(Buffer.concat([initBytes, seg0Ts, seg1Ts])));
  await assert.rejects(() => fsp.stat(`${outFile}.part`));
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test('End-to-end HTTP Server, Signed MediaProxy + Real-Time TS Unwrap + /api/download', async () => {
  const seg0Ts = makeValidTsChunk(4, 0x55);
  const seg1Ts = makeValidTsChunk(4, 0x66);
  const jpgSpoof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    '720/list.m3u8',
  ].join('\n');

  const media = [
    '#EXTM3U',
    '#EXTINF:5.0,',
    'part0.jpg',
    '#EXTINF:5.0,',
    'part1.jpg',
    '#EXT-X-ENDLIST',
  ].join('\n');

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/api/v1/app/episodes/55/play')) {
      return makeFakeResponse({
        episodeId: 55,
        track: 'sub',
        tracks: ['sub'],
        sources: [{ kind: 'iframe', serverId: 3, resolvable: true }],
      });
    }
    if (u.includes('/api/v1/app/episodes/55/resolve')) {
      return makeFakeResponse({
        kind: 'hls',
        serverId: 3,
        url: 'https://stream.cdn.test/ep55/master.m3u8',
        mediaHeaders: { Referer: 'https://embed.cdn.test/' },
        subtitles: [{ lang: 'en', label: 'English', url: 'https://stream.cdn.test/ep55/en.vtt' }],
      });
    }
    if (u === 'https://stream.cdn.test/ep55/master.m3u8') {
      assert.equal(init.headers.Referer, 'https://embed.cdn.test/');
      return makeFakeResponse(master);
    }
    if (u === 'https://stream.cdn.test/ep55/720/list.m3u8') {
      return makeFakeResponse(media);
    }
    if (u === 'https://stream.cdn.test/ep55/720/part0.jpg') {
      return makeFakeResponse(Buffer.concat([jpgSpoof, seg0Ts]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    if (u === 'https://stream.cdn.test/ep55/720/part1.jpg') {
      return makeFakeResponse(Buffer.concat([jpgSpoof, seg1Ts]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    if (u === 'https://stream.cdn.test/ep55/en.vtt') {
      return makeFakeResponse('WEBVTT\n\n00:00.000 --> 00:03.000\nHello!\n');
    }
    throw new Error(`Unexpected HTTP fetch: ${u}`);
  };

  const proxy = new MediaProxy({
    secret: 'unit-test-hmac-secret',
    allowUnsignedDev: false,
    fetchImpl: mockFetch,
  });

  const { server } = createAppServer({ proxy, fetchImpl: mockFetch });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1) Unsigned proxy access is rejected
    const badProxyRes = await fetch(`${baseUrl}/api/proxy/hls?url=https://evil.internal`);
    assert.equal(badProxyRes.status, 500);

    // 2) AniFam 3-mode playback API resolves iframe -> native HLS w/ signed proxy URLs
    const playRes = await fetch(`${baseUrl}/api/anifam/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId: 55, track: 'sub' }),
    });
    assert.equal(playRes.status, 200);
    const playData = await playRes.json();
    assert.equal(playData.mode, 'resolved_hls');
    assert.equal(playData.unwrapTs, true);
    assert.ok(playData.proxyHlsUrl.startsWith('/api/proxy/hls?token='));
    assert.ok(playData.downloadUrl.startsWith('/api/download?token='));

    // 3) Master M3U8 proxy rewrites variant URLs to signed /api/proxy/hls URLs
    const proxiedMasterRes = await fetch(`${baseUrl}${playData.proxyHlsUrl}`);
    assert.equal(proxiedMasterRes.status, 200);
    const rewrittenMaster = await proxiedMasterRes.text();
    const variantLine = rewrittenMaster
      .split(/\r?\n/)
      .find((l) => l.startsWith('/api/proxy/hls?token='));
    assert.ok(variantLine);

    // 4) Media M3U8 proxy rewrites segment URLs to signed /api/proxy/segment URLs
    const proxiedMediaRes = await fetch(`${baseUrl}${variantLine}`);
    const rewrittenMedia = await proxiedMediaRes.text();
    const segLine = rewrittenMedia
      .split(/\r?\n/)
      .find((l) => l.startsWith('/api/proxy/segment?token='));
    assert.ok(segLine);

    // 5) Segment proxy unwraps spoofed JPEG header and sets clean video/mp2t + X-Unwrapped-Ts: 1
    const segRes = await fetch(`${baseUrl}${segLine}`);
    assert.equal(segRes.status, 200);
    assert.equal(segRes.headers.get('x-unwrapped-ts'), '1');
    assert.equal(segRes.headers.get('content-type'), 'video/mp2t');
    const segBytes = Buffer.from(await segRes.arrayBuffer());
    assert.ok(segBytes.equals(seg0Ts));

    // 6) Subtitle proxy adds CORS header
    const subRes = await fetch(`${baseUrl}${playData.subtitles[0].proxyUrl}`);
    assert.equal(subRes.status, 200);
    assert.equal(subRes.headers.get('access-control-allow-origin'), '*');
    assert.ok((await subRes.text()).includes('WEBVTT'));

    // 7) Direct streaming download endpoint (/api/download) assembles both unwrapped segments
    const dlRes = await fetch(`${baseUrl}${playData.downloadUrl}&title=Frieren+Ep+1`);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('x-selected-quality'), '720p');
    assert.match(dlRes.headers.get('content-disposition'), /Frieren Ep 1-720p\.mp4/);
    const dlBytes = Buffer.from(await dlRes.arrayBuffer());
    assert.ok(dlBytes.equals(Buffer.concat([seg0Ts, seg1Ts])));

    // 8) Static frontend HTML loads
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok((await htmlRes.text()).includes('MiruDL + AniFam Web Integration'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
