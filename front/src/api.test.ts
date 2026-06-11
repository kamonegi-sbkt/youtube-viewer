import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed } from './api';

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? 200,
      json: () => Promise.resolve(response.body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchFeed', () => {
  it('returns a well-formed feed', async () => {
    stubFetch({ ok: true, body: { generated_at: '2026-06-11T00:00:00+09:00', videos: [{ video_id: 'abc' }] } });

    const feed = await fetchFeed();

    expect(feed.generated_at).toBe('2026-06-11T00:00:00+09:00');
    expect(feed.videos).toHaveLength(1);
  });

  it('normalizes a non-string generated_at to null', async () => {
    stubFetch({ ok: true, body: { generated_at: 123, videos: [] } });

    const feed = await fetchFeed();

    expect(feed.generated_at).toBeNull();
  });

  it('throws when videos is not an array', async () => {
    stubFetch({ ok: true, body: { generated_at: null, videos: 'nope' } });

    await expect(fetchFeed()).rejects.toThrow('feed response malformed');
  });

  it('throws on a non-2xx response', async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchFeed()).rejects.toThrow('feed request failed: 500');
  });
});
