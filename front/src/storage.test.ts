import { afterEach, describe, expect, it } from 'vitest';
import {
  FILTER_KEY,
  HIDDEN_KEY,
  HIDDEN_MAX_AGE_MS,
  HISTORY_KEY,
  HISTORY_MAX_ENTRIES,
  RESUME_KEY,
  STORAGE_KEY,
  clearResume,
  getResumePosition,
  pruneHidden,
  setResumePosition,
  storage,
  type HistoryMap,
} from './storage';

const memoryStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => memoryStore.set(key, value),
    removeItem: (key: string) => memoryStore.delete(key),
    clear: () => memoryStore.clear(),
  },
});

afterEach(() => {
  localStorage.clear();
});

describe('storage compatibility', () => {
  it('keeps the existing localStorage keys', () => {
    storage.saveLater({
      abc: {
        title: 'Demo',
        channelTitle: 'Channel',
        channelId: 'UC1',
        thumbnail: 'thumb',
        publishedIso: '2026-05-16T00:00:00Z',
        duration: '1:00',
        savedAt: 1,
      },
    });
    storage.saveHistory({});
    storage.saveResume({});
    storage.saveChannelFilter('Channel');

    expect(localStorage.getItem(STORAGE_KEY)).toContain('Demo');
    expect(localStorage.getItem(HISTORY_KEY)).toBe('{}');
    expect(localStorage.getItem(RESUME_KEY)).toBe('{}');
    expect(localStorage.getItem(FILTER_KEY)).toBe('Channel');
  });

  it('round-trips resume positions', () => {
    setResumePosition('abc', 12, 100);

    expect(getResumePosition('abc')).toBe(12);
    clearResume('abc');
    expect(getResumePosition('abc')).toBe(0);
  });

  it('keeps old watch-later entries instead of expiring them', () => {
    storage.saveLater({
      old: {
        title: 'Old Demo',
        channelTitle: 'Channel',
        channelId: 'UC1',
        thumbnail: 'thumb',
        publishedIso: '2026-01-01T00:00:00Z',
        duration: '1:00',
        savedAt: 1,
      },
    });

    expect(storage.loadLater().old?.title).toBe('Old Demo');
  });
});

function historyEntry(watchedAt: number) {
  return {
    title: `Video ${watchedAt}`,
    channelTitle: 'Channel',
    channelId: 'UC1',
    thumbnail: 'thumb',
    publishedIso: '2026-05-16T00:00:00Z',
    duration: '1:00',
    watchedAt,
  };
}

describe('storage pruning', () => {
  it('drops hidden entries older than the max age', () => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const map = {
      stale: now - HIDDEN_MAX_AGE_MS - oneDay,
      fresh: now - HIDDEN_MAX_AGE_MS + oneDay,
    };

    const pruned = pruneHidden(map, now);

    expect(pruned.stale).toBeUndefined();
    expect(pruned.fresh).toBe(map.fresh);
  });

  it('prunes stale hidden entries on load and writes the result back', () => {
    const now = Date.now();
    storage.saveHidden({ stale: now - HIDDEN_MAX_AGE_MS - 1000, fresh: now });

    const loaded = storage.loadHidden();

    expect(loaded.stale).toBeUndefined();
    expect(loaded.fresh).toBe(now);
    expect(localStorage.getItem(HIDDEN_KEY)).not.toContain('stale');
  });

  it('caps history at the newest entries on load', () => {
    const map: HistoryMap = {};
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 1; i += 1) {
      map[`video-${i}`] = historyEntry(i + 1);
    }
    storage.saveHistory(map);

    const loaded = storage.loadHistory();

    expect(Object.keys(loaded)).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(loaded['video-0']).toBeUndefined(); // watchedAt=1 (oldest) is evicted
    expect(loaded[`video-${HISTORY_MAX_ENTRIES}`]).toBeDefined();
    expect(localStorage.getItem(HISTORY_KEY)).not.toContain('"video-0"');
  });

  it('leaves history untouched when under the cap', () => {
    storage.saveHistory({ only: historyEntry(1) });

    expect(Object.keys(storage.loadHistory())).toHaveLength(1);
  });
});
