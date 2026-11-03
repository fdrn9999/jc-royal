/**
 * The bots' own draw reading (ai/strength), for the web's hand analysis (apps/web/src/game/strategy.ts): a replay
 * names a draw the way the bots count one, from the viewer's two cards and the board so far. Nothing new is judged here.
 */
export { cardCode } from './ai/score';
export { BACKDOOR_FLUSH, drawFlags, FLUSH_DRAW, GUTSHOT, NUT_FLUSH_DRAW, OPEN_ENDED, OVERCARDS } from './ai/strength';