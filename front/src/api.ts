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
  return response.json();
}
