import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format';

describe('formatDateTime', () => {
  it('formats an ISO string as M/D HH:mm', () => {
    expect(formatDateTime('2026-06-11T09:05:00+09:00')).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  });

  it('returns an empty string for null', () => {
    expect(formatDateTime(null)).toBe('');
  });

  it('returns an empty string for an invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('');
  });
});
