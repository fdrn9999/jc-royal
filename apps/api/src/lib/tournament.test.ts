import { describe, expect, it } from 'vitest';
import { HANDS_SQL, recordHandsSql } from './tournament';

describe('hand recording of a tournament opened now', () => {
  it('is on only where TOURNAMENT_HANDS_ENABLED is exactly 1', () => {
    expect(recordHandsSql({ TOURNAMENT_HANDS_ENABLED: '1' })).toBe('1');
    for (const v of [undefined, '', '0', 'true', 'on', ' 1', '1; DROP TABLE hands']) expect(recordHandsSql({ TOURNAMENT_HANDS_ENABLED: v })).toBe('0');
  });
});

describe('the hands an entry condition counts', () => {
  it('are cash hands: a recorded tournament hand is not one', () => {
    expect(HANDS_SQL('?1', '?2')).toContain('h.tournament_id IS NULL');
  });
});
