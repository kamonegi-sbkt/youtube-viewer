// View-state decision for the feed tab, extracted so the error-handling
// branches stay unit-testable (main.tsx cannot be imported from tests because
// it renders at module top level).
export type FeedViewState = 'loading' | 'fatal-error' | 'list-with-banner' | 'list';

export function getFeedViewState(loading: boolean, error: string, feedCount: number): FeedViewState {
  if (loading) return 'loading';
  if (error && feedCount === 0) return 'fatal-error';
  if (error) return 'list-with-banner';
  return 'list';
}
