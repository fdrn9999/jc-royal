import type { BotLevel } from './table';

/**
 * How a table bot plays is two separate choices: its level (how well it reads ranges and adapts) and its style (how
 * wide and how aggressively it plays; packages/poker-engine/src/ai/persona.ts). Any level goes with any style.
 */
export const BOT_STYLES = ['balanced', 'tag', 'lag', 'tight-passive', 'loose-passive', 'casual'] as const;
export type BotStyle = (typeof BOT_STYLES)[number];

/**
 * The styles an account with no style of its own is dealt (styleFor): the five there were before 'casual', so adding a
 * style moves no existing bot to another one. Casual plays only where a table or a bot account is set to it.
 */
export const BOT_AUTO_STYLES = ['balanced', 'tag', 'lag', 'tight-passive', 'loose-passive'] as const satisfies readonly BotStyle[];

/**
 * What a style does, as a bot's card says it (apps/web BotCard): how many hands it plays, how often it bets and raises
 * rather than checks and calls, how big it bets and how often it bluffs, each less than (-1), as (0) or more than (1)
 * the balanced style. The engine's tests hold it to the style's own numbers (persona.ts), so the card says what the bot
 * does. A tendency, never a card or a next move.
 */
export const BOT_TRAITS = ['range', 'aggression', 'sizing', 'bluff'] as const;
export type BotTrait = (typeof BOT_TRAITS)[number];
export type BotTraitTier = -1 | 0 | 1;
export const BOT_STYLE_TRAITS: Record<BotStyle, Record<BotTrait, BotTraitTier>> = {
  balanced: { range: 0, aggression: 0, sizing: 0, bluff: 0 },
  tag: { range: -1, aggression: 1, sizing: 0, bluff: -1 },
  lag: { range: 1, aggression: 1, sizing: 0, bluff: 1 },
  'tight-passive': { range: -1, aggression: -1, sizing: 0, bluff: -1 },
  'loose-passive': { range: 1, aggression: -1, sizing: -1, bluff: -1 },
  casual: { range: 1, aggression: 1, sizing: 1, bluff: 1 },
};

/** A table's style for its bots: one style for all of them, or 'auto' for each bot account's own (styleFor). */
export const BOT_TABLE_STYLES = ['auto', ...BOT_STYLES] as const;
export type BotTableStyle = (typeof BOT_TABLE_STYLES)[number];

/** A stable style for a bot account with no style of its own: the same bot keeps it at every table. */
export function styleFor(id: string): BotStyle {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return BOT_AUTO_STYLES[(h >>> 0) % BOT_AUTO_STYLES.length]!;
}

/** What an administrator set for one bot account (bot_profiles); null follows the table it sits at. */
export interface BotProfile {
  level: BotLevel | null;
  style: BotStyle | null;
}

export interface BotPlay {
  level: BotLevel;
  style: BotStyle;
  /** Where each came from: the bot's own setting, the table's, or (style) the bot's automatic one. */
  levelFrom: 'bot' | 'table';
  styleFrom: 'bot' | 'table' | 'auto';
}

/**
 * How a bot plays at a table: each of level and style is the bot's own setting if it has one, else the table's; a
 * table on 'auto' leaves the style to the bot (styleFor), which is how every bot played before settings existed.
 */
export function botPlayOf(botId: string, profile: BotProfile | null | undefined, table: { level: BotLevel; style: BotTableStyle }): BotPlay {
  const level = profile?.level ?? null;
  const style = profile?.style ?? null;
  return {
    level: level ?? table.level,
    levelFrom: level ? 'bot' : 'table',
    style: style ?? (table.style === 'auto' ? styleFor(botId) : table.style),
    styleFrom: style ? 'bot' : table.style === 'auto' ? 'auto' : 'table',
  };
}
