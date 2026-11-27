/**
 * A table's background music, chosen when the room is made. Only these ids travel (request, database, snapshot): the
 * file and the name shown belong to the client's catalogue (packages/audio bgm.ts), so no path or URL ever comes from
 * a request.
 */
export const BGM_IDS = ['black-table-rhythm', 'tournament', 'none'] as const;
export type BgmId = (typeof BGM_IDS)[number];
/** What a room made before the choice existed plays, and what a new one plays unless told otherwise. */
export const DEFAULT_BGM: BgmId = 'black-table-rhythm';

/** The tracks' names as shown where one is chosen (proper names; the client words "none" in its own language). */
export const BGM_TITLES: Readonly<Record<BgmId, string>> = { 'black-table-rhythm': '검은 테이블의 리듬', tournament: 'Tournament', none: 'BGM 없음' };

/** The id as stored or received, or the default for a missing or unknown one (an older room, a retired track). */
export function bgmOf(v: unknown): BgmId {
  return typeof v === 'string' && (BGM_IDS as readonly string[]).includes(v) ? (v as BgmId) : DEFAULT_BGM;
}
