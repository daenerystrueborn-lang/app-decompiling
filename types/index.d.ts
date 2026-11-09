import type { Server } from 'node:http';
import type { PassThrough, Transform } from 'node:stream';

export interface MiruDLAnimeItem {
  id: string;
  title: string;
  thumbnail: string;
  sourceId: 'anilab';
}

export interface MiruDLEpisodeItem {
  id: string;
  title: string;
  number: number;
  filler: boolean;
  servers: Array<{
    name: string;
    id: string;
    language: string;
    type: 'KYOTO';
    sourceId: 'anilab';
  }>;
  sourceId: 'anilab';
}

export interface HlsVariant {
  label: string;
  quality: string;
  width: number | null;
  height: number | null;
  bandwidth: number;
  resolution: string | null;
  codecs: string | null;
  audioGroup: string | null;
  url: string;
  score: number;
}

export interface MiruDLPlaybackResult {
  provider: 'mirudl';
  episodeId: string;
  language: string;
  availableLanguages: MiruDLEpisodeItem['servers'];
  masterUrl: string;
  selectedUrl: string;
  selectedQuality: string;
  variants: HlsVariant[];
  mediaHeaders: Record<string, string>;
  unwrapTs: false;
}

export interface AniFamSubtitleDto {
  lang?: string;
  label?: string;
  url: string;
  default?: boolean;
}

export interface AniFamSkipRange {
  start: number;
  end: number;
}

export interface AniFamSkipDto {
  intro?: AniFamSkipRange | null;
  outro?: AniFamSkipRange | null;
}

export interface AniFamPlaybackSourceDto {
  kind: 'hls' | 'iframe' | string;
  server?: string;
  serverId?: number | null;
  url: string;
  mirrors?: string[];
  mediaHeaders?: Record<string, string>;
  qualities?: Array<{ height: number; bandwidth?: number }>;
  subtitles?: AniFamSubtitleDto[];
  spriteVtt?: string | null;
  thumb?: string | null;
  skip?: AniFamSkipDto | null;
  duration?: number | null;
  resolvable?: boolean | null;
  embedUrl?: string | null;
  backup?: boolean;
}

export interface AniFamPlaybackDto {
  episodeId: number;
  track: string;
  tracks: string[];
  sources: AniFamPlaybackSourceDto[];
  nextEpisode?: { id: number; number: number } | null;
  prevEpisode?: { id: number; number: number } | null;
  resumePosition?: number | null;
  entitlements?: Record<string, unknown> | null;
}

export interface AniFamServerLabel {
  index: number;
  label: string;
  shortLabel: string;
  backupIndex: number | null;
  isNative: boolean;
  isWebOnly: boolean;
  kind: string;
  serverId: number | null;
  cooldownKey: string;
}

export type AniFamPlaybackState =
  | {
      status: 'ready';
      mode: 'hls' | 'resolved_hls';
      isFallback: boolean;
      sourceIndex: number;
      server: AniFamServerLabel;
      servers: AniFamServerLabel[];
      streamUrl: string;
      candidateUrls: string[];
      mediaHeaders: Record<string, string>;
      qualities: Array<{ height: number; bandwidth?: number }>;
      subtitles: Array<AniFamSubtitleDto & { proxyUrl?: string }>;
      spriteVtt: string | null;
      thumb: string | null;
      skip: AniFamSkipDto | null;
      duration: number | null;
      unwrapTs: boolean;
      proxyHlsUrl?: string;
      downloadUrl?: string;
    }
  | {
      status: 'ready';
      mode: 'iframe';
      isFallback: boolean;
      sourceIndex: number;
      server: AniFamServerLabel;
      servers: AniFamServerLabel[];
      embedUrl: string;
      allowedHosts: string[];
      unwrapTs: false;
    }
  | {
      status: 'entitlement_required';
      error: string;
      sourceIndex: number;
      servers: AniFamServerLabel[];
    }
  | {
      status: 'unavailable' | 'failed';
      sourceIndex?: number;
      servers: AniFamServerLabel[];
      episodeId: number | null;
      track: string;
    };

export declare function decodeMiruBaseUrl(): string;
export declare function deriveKyotoInnerKey(rawKeyHex?: string, certHex?: string): Buffer;
export declare function signKyotoRequest(
  pathWithQuery: string,
  opts?: Record<string, unknown>
): { headers: Record<string, string>; canonical: string; signature: string };

export declare class MiruDLClient {
  constructor(options?: {
    anilabBase?: string;
    kyotoBase?: string;
    kyotoMinGapMs?: number;
    kyotoRetryDelaysMs?: number[];
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  });
  kyotoPost(pathWithQuery: string): Promise<any>;
  getHomeSections(): Promise<Array<{ title: string; sourceId: string; posts: MiruDLAnimeItem[] }>>;
  getCategories(): Promise<Array<{ id: string; title: string; sourceId: string }>>;
  getCategoryPosts(categoryId: string, page?: number): Promise<MiruDLAnimeItem[]>;
  search(query: string, page?: number): Promise<MiruDLAnimeItem[]>;
  getAnimeDetails(animeId: string): Promise<Record<string, any>>;
  getEpisodes(animeId: string): Promise<MiruDLEpisodeItem[]>;
  getEpisodeLanguages(episodeId: string): Promise<MiruDLEpisodeItem['servers']>;
  resolveMaster(episodeId: string, language?: string): Promise<string>;
  getQualities(masterUrl: string): Promise<{ isMaster: boolean; variants: HlsVariant[]; mediaTracks: any[] }>;
  resolvePlayback(
    episodeId: string,
    options?: { language?: string; preferredQuality?: string }
  ): Promise<MiruDLPlaybackResult>;
}

export declare class AniFamApiError extends Error {
  status: number;
  body: any;
  isEntitlementWall(): boolean;
}

export declare class AniFamClient {
  activeOrigin: string;
  constructor(options?: {
    primaryApiBase?: string;
    failoverDomains?: string[];
    bearerToken?: string | null;
    appVersion?: string;
    appPlatform?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  });
  setBearerToken(token: string | null): void;
  resolveRelativeDomainUrl(url: string | null | undefined): string | null;
  request(path: string, opts?: { method?: string; body?: any; headers?: Record<string, string>; token?: string | null }): Promise<any>;
  getConfig(): Promise<any>;
  getHome(): Promise<any>;
  search(query: string, page?: number): Promise<any>;
  browse(params?: Record<string, any>): Promise<any>;
  getAnime(animeId: string | number): Promise<any>;
  getEpisodes(animeId: string | number): Promise<any>;
  getPlayback(episodeId: string | number, track?: string): Promise<AniFamPlaybackDto>;
  resolveIframeSource(episodeId: string | number, serverId: string | number, track?: string): Promise<AniFamPlaybackSourceDto>;
  requestDownloadGrant(episodeId: string | number, options?: { track?: string; quality?: string }): Promise<{ grant: any; source: AniFamPlaybackSourceDto | null }>;
  requestCastUrls(episodeId: string | number, body: { track?: string; url: string; subtitles?: string[] }): Promise<{ url: string; subtitles: string[]; expiresAt?: string }>;
}

export declare class SourceCooldownBook {
  constructor(nowFn?: () => number, ttlMs?: number);
  markFailed(key: string): void;
  getActiveKeys(): Set<string>;
  clear(): void;
}

export declare class AniFamPlaybackController {
  constructor(deps: {
    resolveSource: (episodeId: string | number, serverId: string | number, track: string) => Promise<AniFamPlaybackSourceDto>;
    resolveRelativeUrl?: (url: string | null | undefined) => string | null;
    cooldownBook?: SourceCooldownBook;
    preferredServerKey?: string | null;
  });
  loadPlaybackDto(playbackDto: AniFamPlaybackDto): Promise<AniFamPlaybackState>;
  activateSource(idx: number, isFallback?: boolean): Promise<AniFamPlaybackState>;
  handlePlaybackError(): Promise<
    | AniFamPlaybackState
    | { status: 'mirror_switch'; sourceIndex: number; mirrorIndex: number; streamUrl: string; rewriteSubtitleUrl: (subUrl: string) => string }
  >;
  fallbackFromCurrent(): Promise<AniFamPlaybackState>;
}

export declare function unwrapTsBuffer(
  input: Buffer | Uint8Array,
  options?: { forceScan?: boolean }
): { data: Buffer | Uint8Array; strippedBytes: number; signature: string | null };

export declare class TsUnwrapperTransform extends Transform {
  constructor(options?: {
    enabled?: boolean;
    forceScan?: boolean;
    onUnwrapped?: (info: { strippedBytes: number; signature: string | null }) => void;
  });
}

export declare function createHlsDownloadStream(options: {
  playlistUrl: string;
  preferredQuality?: string;
  headers?: Record<string, string>;
  mirrorUrls?: string[];
  concurrency?: number;
  unwrapTs?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ stream: PassThrough; meta: any; done: Promise<any> }>;

export declare function downloadHlsToFile(options: {
  playlistUrl: string;
  outputPath: string;
  preferredQuality?: string;
  headers?: Record<string, string>;
  mirrorUrls?: string[];
  concurrency?: number;
  unwrapTs?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (info: {
    percent: number;
    completedSegments: number;
    totalSegments: number;
    bytesDownloaded: number;
    speedBytesPerSec: number;
  }) => void;
}): Promise<any>;

export declare class MediaProxy {
  constructor(options?: { secret?: string; allowUnsignedDev?: boolean; tokenTtlMs?: number; fetchImpl?: typeof fetch });
  signTarget(payload: {
    url: string;
    headers?: Record<string, string>;
    mirrors?: string[];
    primaryOriginUrl?: string;
    unwrapTs?: boolean;
  }): string;
  verifyToken(token: string): {
    url: string;
    headers: Record<string, string>;
    mirrors: string[];
    primaryOriginUrl: string;
    unwrapTs: boolean;
  };
}

export declare function createAppServer(options?: {
  mirudl?: MiruDLClient;
  anifam?: AniFamClient;
  proxy?: MediaProxy;
  publicDir?: string;
  fetchImpl?: typeof fetch;
}): { server: Server; mirudl: MiruDLClient; anifam: AniFamClient; proxy: MediaProxy };
