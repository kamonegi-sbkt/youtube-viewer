import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { fetchFeed } from './api';
import {
  clearResume,
  getResumePosition,
  setResumePosition,
  storage,
  toStoredEntry,
  type HiddenMap,
  type HistoryMap,
  type LaterMap,
  type ResumeMap,
} from './storage';
import type { ApiVideo, VideoMeta } from './types';
import './styles.css';

declare global {
  interface Window {
    YT?: {
      Player: new (id: string, options: Record<string, unknown>) => YouTubePlayer;
      PlayerState: {
        PLAYING: number;
        PAUSED: number;
        ENDED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YouTubePlayer = {
  loadVideoById: (options: { videoId: string; startSeconds?: number }) => void;
  stopVideo?: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
};

type TabName = 'feed' | 'later' | 'history';

function apiVideoToMeta(video: ApiVideo): VideoMeta {
  return {
    videoId: video.video_id,
    title: video.title,
    channelTitle: video.channel_title,
    channelId: video.channel_id,
    thumbnail: video.thumbnail,
    publishedIso: video.published_iso,
    duration: video.duration_text || '',
    relTime: video.rel_time || '',
    badgeKind: video.badge_kind || '',
  };
}

function relTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'たった今';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}日前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / (86400 * 7))}週間前`;
  if (seconds < 86400 * 365) return `${Math.floor(seconds / (86400 * 30))}ヶ月前`;
  return `${Math.floor(seconds / (86400 * 365))}年前`;
}

function useYouTubePlayer(onResumeChange: (resume: ResumeMap) => void) {
  const playerRef = useRef<YouTubePlayer | null>(null);
  const currentVideoIdRef = useRef<string | null>(null);
  const intervalRef = useRef<number | null>(null);
  const [overlayMode, setOverlayMode] = useState<'closed' | 'open' | 'mini'>('closed');
  const [currentMeta, setCurrentMeta] = useState<VideoMeta | null>(null);
  const [isReady, setReady] = useState(false);

  const stopInterval = () => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const savePositionNow = () => {
    const player = playerRef.current;
    const videoId = currentVideoIdRef.current;
    if (!player || !videoId) return;
    try {
      const resume = setResumePosition(videoId, player.getCurrentTime(), player.getDuration());
      onResumeChange({ ...resume });
    } catch {
      // YouTube iframe can throw while it is tearing down.
    }
  };

  const ensureApi = () => {
    if (window.YT?.Player) {
      window.onYouTubeIframeAPIReady?.();
      return;
    }
    if (document.querySelector('script[data-youtube-api]')) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.dataset.youtubeApi = 'true';
    document.head.appendChild(tag);
  };

  useEffect(() => {
    window.onYouTubeIframeAPIReady = () => {
      if (playerRef.current || !window.YT?.Player) return;
      playerRef.current = new window.YT.Player('player-iframe', {
        width: '100%',
        height: '100%',
        playerVars: {
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => setReady(true),
          onStateChange: (event: { data: number }) => {
            const state = window.YT?.PlayerState;
            if (!state) return;
            if (event.data === state.PLAYING) {
              stopInterval();
              intervalRef.current = window.setInterval(savePositionNow, 5000);
            }
            if (event.data === state.PAUSED) {
              stopInterval();
              savePositionNow();
            }
            if (event.data === state.ENDED) {
              stopInterval();
              const videoId = currentVideoIdRef.current;
              if (videoId) onResumeChange({ ...clearResume(videoId) });
            }
          },
        },
      });
    };
    ensureApi();
    return () => {
      stopInterval();
      window.onYouTubeIframeAPIReady = undefined;
    };
  }, []);

  useEffect(() => {
    const handlePageHide = () => savePositionNow();
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') savePositionNow();
    };
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const openPlayer = (meta: VideoMeta) => {
    const videoId = meta.videoId;
    if (currentVideoIdRef.current && currentVideoIdRef.current !== videoId) {
      savePositionNow();
    }
    currentVideoIdRef.current = videoId;
    setCurrentMeta(meta);
    setOverlayMode('open');
    const startSeconds = getResumePosition(videoId);
    if (isReady && playerRef.current) {
      playerRef.current.loadVideoById({ videoId, startSeconds });
    } else {
      const tick = window.setInterval(() => {
        if (playerRef.current) {
          window.clearInterval(tick);
          playerRef.current.loadVideoById({ videoId, startSeconds });
        }
      }, 100);
    }
  };

  const closePlayer = () => {
    savePositionNow();
    stopInterval();
    currentVideoIdRef.current = null;
    playerRef.current?.stopVideo?.();
    setCurrentMeta(null);
    setOverlayMode('closed');
  };

  return {
    overlayMode,
    currentMeta,
    openPlayer,
    closePlayer,
    minimizePlayer: () => setOverlayMode('mini'),
    expandPlayer: () => setOverlayMode('open'),
  };
}

// Pull-to-refresh for touch devices. Fires only when the page is scrolled to the
// very top and the gesture is a downward, mostly-vertical drag, so it never steals
// normal vertical scrolling or the horizontal tab/channel strips.
function usePullToRefresh(onRefresh: () => Promise<void> | void, enabled: boolean) {
  const [pull, setPull] = useState(0);
  const [active, setActive] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const pulling = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const THRESHOLD = 64;
  const MAX = 96;

  useEffect(() => {
    const onStart = (event: TouchEvent) => {
      if (!enabledRef.current || event.touches.length !== 1 || window.scrollY > 0) return;
      startX.current = event.touches[0].clientX;
      startY.current = event.touches[0].clientY;
      pulling.current = true;
    };
    const onMove = (event: TouchEvent) => {
      if (!pulling.current) return;
      const dy = event.touches[0].clientY - startY.current;
      const dx = event.touches[0].clientX - startX.current;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || window.scrollY > 0) {
        pulling.current = false;
        setPull(0);
        return;
      }
      event.preventDefault(); // suppress iOS rubber-band only while actively pulling at the top
      setPull(Math.min(MAX, dy * 0.5));
    };
    const onEnd = async () => {
      if (!pulling.current) return;
      pulling.current = false;
      if (pull >= THRESHOLD) {
        setActive(true);
        setPull(THRESHOLD);
        try {
          await onRefresh();
        } finally {
          setActive(false);
          setPull(0);
        }
      } else {
        setPull(0);
      }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [onRefresh, pull]);

  return { pull, active, threshold: THRESHOLD };
}

function VideoCard({
  meta,
  bookmarked,
  resume,
  watched,
  onOpen,
  onToggleLater,
  onDismiss,
}: {
  meta: VideoMeta;
  bookmarked: boolean;
  resume?: { position: number; duration: number };
  watched?: boolean;
  onOpen: (meta: VideoMeta) => void;
  onToggleLater: (meta: VideoMeta) => void;
  onDismiss?: (meta: VideoMeta) => void;
}) {
  const timeLabel = meta.relTime || relTime(meta.publishedIso);
  const progress = resume?.duration ? Math.max(0, Math.min(1, resume.position / resume.duration)) : 0;

  return (
    <article className="card" onClick={() => onOpen(meta)}>
      <div className={`thumb${watched ? ' is-watched' : ''}`}>
        <img src={meta.thumbnail} alt="" loading="lazy" />
        <div className="play-overlay">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        {onDismiss ? (
          <button
            className="dismiss-btn"
            type="button"
            aria-label="興味なし（新着から隠す）"
            title="興味なし"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onDismiss(meta);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : null}
        <button
          className="bookmark-btn"
          type="button"
          aria-label={bookmarked ? 'あとで見るから削除' : 'あとで見るに追加'}
          aria-pressed={bookmarked}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleLater(meta);
          }}
        >
          <svg className="bookmark-icon" viewBox="0 0 24 24" fill={bookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        {watched ? (
          <span className="watched-badge" aria-label="視聴済み">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            視聴済み
          </span>
        ) : null}
        {meta.duration ? <span className={`video-length-badge${meta.badgeKind ? ` is-${meta.badgeKind}` : ''}`}>{meta.duration}</span> : null}
        {progress > 0 ? (
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${progress * 100}%` }} />
          </div>
        ) : null}
      </div>
      <div className="meta">
        <div className="title">{meta.title}</div>
        <div className="sub">
          <span className="channel">{meta.channelTitle}</span>
          {timeLabel ? (
            <>
              <span className="dot">•</span>
              <span className="time">{timeLabel}</span>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function PlayerOverlay({
  mode,
  meta,
  onClose,
  onMinimize,
  onExpand,
}: {
  mode: 'closed' | 'open' | 'mini';
  meta: VideoMeta | null;
  onClose: () => void;
  onMinimize: () => void;
  onExpand: () => void;
}) {
  return (
    <div className={`player-overlay${mode === 'mini' ? ' is-pip' : ''}`} hidden={mode === 'closed'} onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="player-frame">
        <div className="player-controls">
          <button className="player-minimize" type="button" aria-label="小窓で表示" title="小窓で表示" onClick={onMinimize}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
          </button>
          <button className="player-expand" type="button" aria-label="全画面に戻す" title="全画面に戻す" onClick={onExpand}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
          </button>
          <button className="player-close" type="button" aria-label="閉じる" title="閉じる" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="player-iframe-wrap">
          <div id="player-host">
            <div id="player-iframe" />
          </div>
        </div>
        {meta ? (
          <div className="player-meta">
            <div className="player-title">{meta.title}</div>
            <div className="player-channel">{meta.channelTitle}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <p>{title}</p>
      {hint ? <p className="empty-hint">{hint}</p> : null}
    </div>
  );
}

function App() {
  const [feedVideos, setFeedVideos] = useState<VideoMeta[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<TabName>(() => {
    if (location.hash === '#later') return 'later';
    if (location.hash === '#history') return 'history';
    return 'feed';
  });
  const [later, setLater] = useState<LaterMap>(() => storage.loadLater());
  const [hidden, setHidden] = useState<HiddenMap>(() => storage.loadHidden());
  const [watchHistory, setWatchHistory] = useState<HistoryMap>(() => storage.loadHistory());
  const [resume, setResume] = useState<ResumeMap>(() => storage.loadResume());
  const [selectedChannel, setSelectedChannel] = useState(() => storage.loadChannelFilter());
  const [refreshing, setRefreshing] = useState(false);
  const [lastDismissed, setLastDismissed] = useState<VideoMeta | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const player = useYouTubePlayer(setResume);

  const loadFeed = useCallback(async () => {
    try {
      const feed = await fetchFeed();
      setFeedVideos(feed.videos.map(apiVideoToMeta));
      setGeneratedAt(feed.generated_at);
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'feed request failed');
    }
  }, []);

  useEffect(() => {
    loadFeed().finally(() => setLoading(false));
  }, [loadFeed]);

  const refreshFeed = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await loadFeed();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, loadFeed]);

  const ptr = usePullToRefresh(refreshFeed, player.overlayMode !== 'open');

  useEffect(() => () => {
    if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
  }, []);

  useEffect(() => {
    if (activeTab === 'later') window.history.replaceState(null, '', '#later');
    else if (activeTab === 'history') window.history.replaceState(null, '', '#history');
    else window.history.replaceState(null, '', location.pathname + location.search);
  }, [activeTab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') player.closePlayer();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [player.closePlayer]);

  const laterEntries = useMemo(
    () => Object.entries(later).map(([videoId, entry]) => ({ videoId, ...entry })).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)),
    [later],
  );
  const historyEntries = useMemo(
    () => Object.entries(watchHistory).map(([videoId, entry]) => ({ videoId, ...entry })).sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)),
    [watchHistory],
  );
  const channels = useMemo(() => {
    const names = new Set<string>();
    feedVideos.forEach((v) => names.add(v.channelTitle));
    laterEntries.forEach((v) => names.add(v.channelTitle));
    historyEntries.forEach((v) => names.add(v.channelTitle));
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'ja'));
  }, [feedVideos, laterEntries, historyEntries]);

  useEffect(() => {
    if (selectedChannel && !channels.includes(selectedChannel)) {
      setSelectedChannel('');
      storage.saveChannelFilter('');
    }
  }, [channels, selectedChannel]);

  const matchesChannel = (video: { channelTitle: string }) => !selectedChannel || video.channelTitle === selectedChannel;
  const visibleFeed = feedVideos.filter((video) => !hidden[video.videoId] && matchesChannel(video));
  const visibleLater = laterEntries.filter(matchesChannel);
  const visibleHistory = historyEntries.filter(matchesChannel);

  const addHistory = (meta: VideoMeta) => {
    const next = {
      ...storage.loadHistory(),
      [meta.videoId]: {
        ...toStoredEntry(meta),
        watchedAt: Date.now(),
      },
    };
    storage.saveHistory(next);
    setWatchHistory(next);
  };

  const openVideo = (meta: VideoMeta) => {
    addHistory(meta);
    player.openPlayer(meta);
  };

  const dismissVideo = (meta: VideoMeta) => {
    const next = { ...storage.loadHidden(), [meta.videoId]: Date.now() };
    storage.saveHidden(next);
    setHidden(next);
    setLastDismissed(meta);
    if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => setLastDismissed(null), 5000);
  };

  const undoDismiss = () => {
    if (!lastDismissed) return;
    const next = { ...storage.loadHidden() };
    delete next[lastDismissed.videoId];
    storage.saveHidden(next);
    setHidden(next);
    setLastDismissed(null);
    if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
  };

  const toggleLater = (meta: VideoMeta) => {
    const next = { ...storage.loadLater() };
    if (next[meta.videoId]) {
      delete next[meta.videoId];
      if (activeTab === 'later') {
        const nextHidden = { ...storage.loadHidden(), [meta.videoId]: Date.now() };
        storage.saveHidden(nextHidden);
        setHidden(nextHidden);
      }
    } else {
      next[meta.videoId] = {
        ...toStoredEntry(meta),
        savedAt: Date.now(),
      };
    }
    storage.saveLater(next);
    setLater(next);
  };

  const chooseChannel = (channel: string) => {
    storage.saveChannelFilter(channel);
    setSelectedChannel(channel);
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <span className="logo-dot" />
          <span>My YouTube</span>
        </div>
        <nav className="tabs" role="tablist">
          <button className={`tab${activeTab === 'feed' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={activeTab === 'feed'} onClick={() => setActiveTab('feed')}>新着</button>
          <button className={`tab${activeTab === 'later' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={activeTab === 'later'} onClick={() => setActiveTab('later')}>あとで{laterEntries.length ? <span className="tab-count">{laterEntries.length}</span> : null}</button>
          <button className={`tab${activeTab === 'history' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={activeTab === 'history'} onClick={() => setActiveTab('history')}>履歴</button>
        </nav>
        <div className="topbar-actions">
          <button className={`topbar-btn${refreshing ? ' is-spinning' : ''}`} type="button" aria-label="再読み込み" title="再読み込み" disabled={refreshing} onClick={refreshFeed}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /></svg>
          </button>
        </div>
      </header>

      <div className="ptr-indicator" style={{ height: ptr.pull, opacity: ptr.pull ? 1 : 0 }} aria-hidden={!ptr.pull}>
        <div className={`ptr-spinner${ptr.active || ptr.pull >= ptr.threshold ? ' is-active' : ''}`} />
      </div>

      <section className="channel-filter" aria-label="チャンネル絞り込み">
        <div className="channel-filter-scroll" role="listbox" aria-label="チャンネル">
          <button className={`channel-chip${selectedChannel ? '' : ' is-active'}`} type="button" aria-selected={!selectedChannel} onClick={() => chooseChannel('')}>すべて</button>
          {channels.map((channel) => (
            <button key={channel} className={`channel-chip${selectedChannel === channel ? ' is-active' : ''}`} type="button" aria-selected={selectedChannel === channel} onClick={() => chooseChannel(channel)}>
              {channel}
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <main className="grid">
          <div className="loading-shell">
            <div className="loading-spinner" aria-label="読み込み中" />
            <p className="loading-text">起動中...</p>
          </div>
        </main>
      ) : null}

      {error ? <Empty title="フィードを読み込めませんでした" hint={error} /> : null}

      {!loading && !error && activeTab === 'feed' ? (
        visibleFeed.length ? (
          <main className="grid">
            {visibleFeed.map((meta) => (
              <VideoCard key={meta.videoId} meta={meta} bookmarked={Boolean(later[meta.videoId])} resume={resume[meta.videoId]} watched={Boolean(watchHistory[meta.videoId])} onOpen={openVideo} onToggleLater={toggleLater} onDismiss={dismissVideo} />
            ))}
          </main>
        ) : (
          <Empty title={selectedChannel ? 'このチャンネルの新着動画はありません' : '新着動画はありません'} hint={selectedChannel ? '別のチャンネルを選ぶと表示されます' : generatedAt ? `最終更新: ${generatedAt}` : undefined} />
        )
      ) : null}

      {!loading && !error && activeTab === 'later' ? (
        visibleLater.length ? (
          <main className="grid">
            {visibleLater.map((entry) => (
              <VideoCard key={entry.videoId} meta={entry} bookmarked={Boolean(later[entry.videoId])} resume={resume[entry.videoId]} onOpen={openVideo} onToggleLater={toggleLater} />
            ))}
          </main>
        ) : (
          <Empty title={laterEntries.length ? 'このチャンネルのあとで見る動画はありません' : 'あとで見る動画はまだありません'} hint={laterEntries.length ? '別のチャンネルを選ぶと表示されます' : 'カードの右上のブックマークをタップして追加'} />
        )
      ) : null}

      {!loading && !error && activeTab === 'history' ? (
        visibleHistory.length ? (
          <main className="grid">
            {visibleHistory.map((entry) => (
              <VideoCard key={entry.videoId} meta={entry} bookmarked={Boolean(later[entry.videoId])} resume={resume[entry.videoId]} onOpen={openVideo} onToggleLater={toggleLater} />
            ))}
          </main>
        ) : (
          <Empty title={historyEntries.length ? 'このチャンネルの再生履歴はありません' : '再生履歴はまだありません'} hint={historyEntries.length ? '別のチャンネルを選ぶと表示されます' : '動画を開くとここに追加されます'} />
        )
      ) : null}

      <PlayerOverlay mode={player.overlayMode} meta={player.currentMeta} onClose={player.closePlayer} onMinimize={player.minimizePlayer} onExpand={player.expandPlayer} />

      {lastDismissed ? (
        <div className={`toast${player.overlayMode === 'mini' ? ' is-raised' : ''}`} role="status">
          <span className="toast-text">「{lastDismissed.title}」を非表示にしました</span>
          <button type="button" className="toast-undo" onClick={undoDismiss}>元に戻す</button>
        </div>
      ) : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
