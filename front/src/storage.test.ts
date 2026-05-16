import { afterEach, describe, expect, it } from 'vitest';
import { FILTER_KEY, HISTORY_KEY, RESUME_KEY, STORAGE_KEY, clearResume, getResumePosition, setResumePosition, storage } from './storage';

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
});
