import type { FeedResponse } from './types';

export async function fetchFeed(): Promise<FeedResponse> {
  const response = await fetch('/api/v1/feed', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`feed request failed: ${response.status}`);
  }
  return response.json();
}
