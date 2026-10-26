import type { BotLevel } from './table';

/**
 * How a table bot plays is two separate choices: its level (how well it reads ranges and adapts) and its style (how
 * wide and how aggressively it plays; packages/poker-engine/src/ai/persona.ts). Any level goes with any style.
 */
export const BOT_STYLES = ['balanced', 'tag', 'lag', 'tight-passive', 'loose-passive'] as const;
export type BotStyle = (typeof BOT_STYLES)[number];

/** A table's style for its bots: one style for all of them, or 'auto' for each bot account's own (styleFor). */
export const BOT_TABLE_STYLES = ['auto', ...BOT_STYLES] as const;
export type BotTableStyle = (typeof BOT_TABLE_STYLES)[number];

/** A stable style for a bot account with no style of its own: the same bot keeps it at every table. */
export function styleFor(id: string): BotStyle {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return BOT_STYLES[(h >>> 0) % BOT_STYLES.length]!;
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
