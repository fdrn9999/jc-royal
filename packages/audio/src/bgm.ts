/**
 * The catalogue of table music: every recording a room can choose, by the id the room stores (packages/types bgm.ts
 * has the same ids, which is all the server knows of them). The file and its level live only here, so a new track is
 * one more id there and one more line here.
 *
 * `gain` brings a recording to the loudness of the first (ffmpeg ebur128, integrated): "검은 테이블의 리듬" is -15.6
 * LUFS and plays as mastered; "Tournament" is -14.0 LUFS, so it plays 1.6 dB down. `null`: a table without music.
 */
import type { MusicTracks } from './music';

export const BGM_TRACKS = {
  'black-table-rhythm': { url: new URL('./music/black-table-rhythm.mp3', import.meta.url).href, gain: 1 },
  tournament: { url: new URL('./music/tournament.mp3', import.meta.url).href, gain: 0.83 },
  none: null,
} as const satisfies MusicTracks;

export type BgmTrackId = keyof typeof BGM_TRACKS;
