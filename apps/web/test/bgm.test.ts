import { BGM_TRACKS, type BgmTrackId } from '@jc/audio';
import { BGM_IDS, BGM_TITLES, bgmOf, DEFAULT_BGM, PrivateTournamentCreateSchema, RoomCreateSchema, TableInputSchema, type BgmId } from '@jc/types';
import { describe, expect, it } from 'vitest';

/**
 * The table's music as a choice: the ids the server accepts (a whitelist, never a file or a URL), what an older room
 * without one plays, and that every id has its recording (or none, for the id that plays nothing).
 */
// The catalogue of ids (@jc/types) and the recordings (@jc/audio) are the same set: either one changed alone fails here.
const sameIds: [BgmId] extends [BgmTrackId] ? ([BgmTrackId] extends [BgmId] ? true : never) : never = true;

const room = { name: 'Friday night', maxSeats: 6, bigBlind: 20, minBuyIn: 400, maxBuyIn: 2000 };

describe('the table’s music: its catalogue', () => {
  it('three choices: the first one is the default, one plays nothing, and each has a title and a recording', () => {
    expect(sameIds).toBe(true);
    expect([...BGM_IDS]).toEqual(['black-table-rhythm', 'tournament', 'none']);
    expect(DEFAULT_BGM).toBe('black-table-rhythm');
    expect(Object.keys(BGM_TRACKS).sort()).toEqual([...BGM_IDS].sort());
    expect(BGM_TITLES).toEqual({ 'black-table-rhythm': '검은 테이블의 리듬', tournament: 'Tournament', none: 'BGM 없음' });
    expect(BGM_TRACKS.none).toBeNull();
    for (const id of ['black-table-rhythm', 'tournament'] as const) {
      // A file built with the app (hashed, served from its own origin): never one inlined into the source.
      expect(BGM_TRACKS[id].url).toMatch(/\.mp3$/);
      expect(BGM_TRACKS[id].url).not.toMatch(/^data:/);
    }
    expect(BGM_TRACKS.tournament.url).toContain('tournament');
  });

  it('a room made before the choice existed, or holding an id no longer known, plays the default', () => {
    expect(bgmOf(undefined)).toBe('black-table-rhythm');
    expect(bgmOf(null)).toBe('black-table-rhythm');
    expect(bgmOf('')).toBe('black-table-rhythm');
    expect(bgmOf('some-old-track')).toBe('black-table-rhythm');
    expect(bgmOf(7)).toBe('black-table-rhythm');
    expect(bgmOf('tournament')).toBe('tournament');
    expect(bgmOf('none')).toBe('none');
  });
});

describe('the table’s music: what the server accepts', () => {
  it('a room: one of the ids, the default when left out', () => {
    expect(RoomCreateSchema.parse(room).bgmId).toBe('black-table-rhythm');
    for (const id of BGM_IDS) expect(RoomCreateSchema.parse({ ...room, bgmId: id }).bgmId).toBe(id);
  });

  it('never a URL, a path, another id or anything that is not text', () => {
    for (const bad of ['https://example.com/a.mp3', '/assets/tournament.mp3', '../music/tournament.mp3', 'C:\\Users\\me\\tournament.mp3', 'Tournament', 'tournament ', '', 'constructor', '__proto__', null, 1, {}, ['tournament']]) {
      expect(RoomCreateSchema.safeParse({ ...room, bgmId: bad }).success, String(bad)).toBe(false);
      expect(PrivateTournamentCreateSchema.safeParse({ templateId: 'sng-6', bgmId: bad }).success, String(bad)).toBe(false);
    }
    // No other way in: a field the forms do not have is dropped (a room) or refused (a tournament), never read or stored.
    expect(RoomCreateSchema.parse({ ...room, bgmUrl: 'https://example.com/a.mp3' })).not.toHaveProperty('bgmUrl');
    expect(PrivateTournamentCreateSchema.safeParse({ templateId: 'sng-6', bgmUrl: 'https://example.com/a.mp3' }).success).toBe(false);
  });

  it('an official table and a private tournament take the same ids', () => {
    expect(TableInputSchema.shape.bgmId.parse(undefined)).toBe('black-table-rhythm');
    expect(TableInputSchema.shape.bgmId.safeParse('tournament').success).toBe(true);
    expect(TableInputSchema.shape.bgmId.safeParse('https://example.com/a.mp3').success).toBe(false);
    expect(PrivateTournamentCreateSchema.parse({ templateId: 'sng-6' }).bgmId).toBeUndefined();
    expect(PrivateTournamentCreateSchema.parse({ templateId: 'sng-6', bgmId: 'none' }).bgmId).toBe('none');
  });
});
