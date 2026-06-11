import type { FeedResponse } from './types';

export async function fetchFeed(): Promise<FeedResponse> {
  const url = `/api/v1/feed?reload=${Date.now()}`;
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  if (!response.ok) {
    throw new Error(`feed request failed: ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !Array.isArray((data as FeedResponse).videos)) {
    throw new Error('feed response malformed');
  }
  const feed = data as FeedResponse;
  return {
    generated_at: typeof feed.generated_at === 'string' ? feed.generated_at : null,
    videos: feed.videos,
  };
}
