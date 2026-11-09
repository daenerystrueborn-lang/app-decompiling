/**
 * Drop-in React / Next.js Client Component Example
 *
 * Shows how to integrate `AnimeSitePlayer` + `WebEpisodeDownloader` from `/public/js/`
 * against the unified backend (`/api/anifam/*`, `/api/mirudl/*`, `/api/proxy/*`, `/api/download`).
 */

import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AnimeSitePlayer } from '../public/js/site-player.js';
import { WebEpisodeDownloader } from '../public/js/web-downloader.js';

export function AnimeEpisodeWidget({
  provider = 'anifam',
  episodeId,
  title = 'Episode',
  track = 'sub',
  quality = '1080p',
  apiBase = '',
}) {
  const videoRef = useRef(null);
  const iframeRef = useRef(null);
  const playerRef = useRef(null);
  const downloaderRef = useRef(new WebEpisodeDownloader({ apiBase }));

  const [session, setSession] = useState(null);
  const [skipCue, setSkipCue] = useState(null);
  const [dlProgress, setDlProgress] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!videoRef.current) return;
    const player = new AnimeSitePlayer({
      videoEl: videoRef.current,
      iframeEl: iframeRef.current,
      apiBase,
      hlsConstructor: Hls,
      onStateChange: (s) => setSession(s),
      onSkipCue: (cue) => setSkipCue(cue),
      onError: (err) => setError(err.message),
    });
    playerRef.current = player;
    return () => player.destroy();
  }, [apiBase]);

  useEffect(() => {
    if (!playerRef.current || !episodeId) return;
    setError('');
    const load = async () => {
      if (provider === 'mirudl') {
        await playerRef.current.playMiruDL(episodeId, {
          lang: track === 'dub' ? 'eng' : 'jpn',
          quality,
        });
      } else {
        await playerRef.current.playAniFam(episodeId, { track });
      }
    };
    load().catch((err) => setError(err.message));
  }, [provider, episodeId, track, quality]);

  const handleServerDownload = () => {
    if (!session) return;
    downloaderRef.current.triggerServerDownload({
      downloadUrl: session.downloadUrl,
      quality,
      title,
    });
  };

  const handleBrowserDownload = async () => {
    if (!session?.proxyHlsUrl) return;
    await downloaderRef.current.downloadInBrowserWithProgress({
      proxyHlsUrl: session.proxyHlsUrl,
      preferredQuality: quality,
      filename: `${title}.mp4`,
      onProgress: setDlProgress,
    });
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && <div role="alert">{error}</div>}
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#000' }}>
        <video ref={videoRef} controls playsInline style={{ width: '100%', height: '100%' }} />
        <iframe ref={iframeRef} hidden title="Embed Fallback" style={{ width: '100%', height: '100%', border: 0 }} />
        {skipCue && (
          <button
            type="button"
            onClick={() => playerRef.current?.jumpToSeconds(skipCue.end)}
            style={{ position: 'absolute', right: 16, bottom: 52 }}
          >
            {skipCue.type === 'intro' ? 'Skip Intro' : 'Skip Outro'}
          </button>
        )}
      </div>

      {session?.servers?.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {session.servers.map((srv) => (
            <button
              key={srv.index}
              type="button"
              onClick={() => playerRef.current?.playAniFam(episodeId, { track, serverIndex: srv.index })}
              style={{ fontWeight: srv.index === session.sourceIndex ? 'bold' : 'normal' }}
            >
              {srv.isWebOnly ? `${srv.label} [Web]` : srv.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={!session?.downloadUrl} onClick={handleServerDownload}>
          Download (Server Stream)
        </button>
        <button type="button" disabled={!session?.proxyHlsUrl} onClick={handleBrowserDownload}>
          Download in Browser
        </button>
      </div>

      {dlProgress && (
        <div>
          {dlProgress.percent}% ({dlProgress.completed}/{dlProgress.total} segments • {dlProgress.quality})
        </div>
      )}
    </div>
  );
}
