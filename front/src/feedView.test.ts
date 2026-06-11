import { describe, expect, it } from 'vitest';
import { getFeedViewState } from './feedView';

describe('getFeedViewState', () => {
  it('is loading during the initial fetch', () => {
    expect(getFeedViewState(true, '', 0)).toBe('loading');
  });

  it('is a fatal error when the initial fetch fails with nothing to show', () => {
    expect(getFeedViewState(false, 'boom', 0)).toBe('fatal-error');
  });

  it('keeps the existing list with a banner when a refresh fails', () => {
    expect(getFeedViewState(false, 'boom', 12)).toBe('list-with-banner');
  });

  it('is a plain list when everything succeeds', () => {
    expect(getFeedViewState(false, '', 12)).toBe('list');
  });
});
