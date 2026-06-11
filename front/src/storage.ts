import type { HistoryEntry, LaterEntry, ResumeEntry, VideoMeta } from './types';

export const STORAGE_KEY = 'ytv_watch_later';
export const HIDDEN_KEY = 'ytv_hidden';
export const RESUME_KEY = 'ytv_resume';
export const HISTORY_KEY = 'ytv_history';
export const FILTER_KEY = 'ytv_channel_filter';

export type LaterMap = Record<string, LaterEntry>;
export type HiddenMap = Record<string, number>;
export type ResumeMap = Record<string, ResumeEntry>;
export type HistoryMap = Record<string, HistoryEntry>;

// Hidden/history entries would otherwise grow forever; watch-later is kept
// untouched on purpose (saving a video is an explicit promise to keep it).
export const HIDDEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX_ENTRIES = 200;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function pruneHidden(map: HiddenMap, now = Date.now()): HiddenMap {
  const next: HiddenMap = {};
  for (const [videoId, hiddenAt] of Object.entries(map)) {
    if (now - hiddenAt < HIDDEN_MAX_AGE_MS) next[videoId] = hiddenAt;
  }
  return next;
}

export function pruneHistory(map: HistoryMap): HistoryMap {
  const entries = Object.entries(map).sort((a, b) => (b[1].watchedAt || 0) - (a[1].watchedAt || 0));
  if (entries.length <= HISTORY_MAX_ENTRIES) return map;
  return Object.fromEntries(entries.slice(0, HISTORY_MAX_ENTRIES));
}

export const storage = {
  loadLater: (): LaterMap => readJson<LaterMap>(STORAGE_KEY, {}),
  saveLater: (value: LaterMap): void => writeJson(STORAGE_KEY, value),
  loadHidden: (): HiddenMap => {
    const raw = readJson<HiddenMap>(HIDDEN_KEY, {});
    const pruned = pruneHidden(raw);
    if (Object.keys(pruned).length !== Object.keys(raw).length) writeJson(HIDDEN_KEY, pruned);
    return pruned;
  },
  saveHidden: (value: HiddenMap): void => writeJson(HIDDEN_KEY, value),
  loadResume: (): ResumeMap => readJson<ResumeMap>(RESUME_KEY, {}),
  saveResume: (value: ResumeMap): void => writeJson(RESUME_KEY, value),
  loadHistory: (): HistoryMap => {
    const raw = readJson<HistoryMap>(HISTORY_KEY, {});
    const pruned = pruneHistory(raw);
    if (pruned !== raw) writeJson(HISTORY_KEY, pruned);
    return pruned;
  },
  saveHistory: (value: HistoryMap): void => writeJson(HISTORY_KEY, value),
  loadChannelFilter: (): string => {
    try {
      return localStorage.getItem(FILTER_KEY) || '';
    } catch {
      return '';
    }
  },
  saveChannelFilter: (value: string): void => localStorage.setItem(FILTER_KEY, value || ''),
};

export function toStoredEntry(meta: VideoMeta): Omit<LaterEntry, 'savedAt'> {
  return {
    title: meta.title,
    channelTitle: meta.channelTitle,
    channelId: meta.channelId || '',
    thumbnail: meta.thumbnail,
    publishedIso: meta.publishedIso,
    duration: meta.duration || '',
  };
}

export function getResumePosition(videoId: string): number {
  const entry = storage.loadResume()[videoId];
  if (!entry) return 0;
  const position = Number(entry.position) || 0;
  return position < 5 ? 0 : position;
}

export function setResumePosition(videoId: string, position: number, duration: number): ResumeMap {
  const all = storage.loadResume();
  const safePosition = Number(position) || 0;
  const safeDuration = Number(duration) || 0;
  if (!videoId || !safeDuration || safePosition < 5) {
    return all;
  }
  if (safePosition >= safeDuration - 10 || safePosition / safeDuration >= 0.95) {
    delete all[videoId];
  } else {
    all[videoId] = { position: safePosition, duration: safeDuration, updatedAt: Date.now() };
  }
  storage.saveResume(all);
  return all;
}

export function clearResume(videoId: string): ResumeMap {
  const all = storage.loadResume();
  if (all[videoId]) {
    delete all[videoId];
    storage.saveResume(all);
  }
  return all;
}
