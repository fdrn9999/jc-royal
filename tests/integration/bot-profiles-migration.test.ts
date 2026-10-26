import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { botPlayOf, styleFor, type BotLevel, type BotTableStyle } from '@jc/types';
import { describe, expect, it } from 'vitest';

// Runs the real migration files on an in-memory SQLite, with bots and tables written the way the app wrote them before.
const dir = new URL('../../packages/db/migrations/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const apply = (db: DatabaseSync, file: string) => {
  for (const stmt of readFileSync(new URL(file, dir), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
};

describe('migration 0034_bot_profiles', () => {
  it('keeps every bot playing as before: the table level, its own automatic style, account untouched', () => {
    const db = new DatabaseSync(':memory:');
    const at = files.findIndex((f) => f.startsWith('0034_'));
    expect(at).toBeGreaterThan(0);
    for (const f of files.slice(0, at)) apply(db, f);

    const user = db.prepare("INSERT INTO users (id, email, nickname, password_hash, is_bot, balance) VALUES (?, ?, ?, ?, ?, ?)");
    const bots = Array.from({ length: 12 }, (_, i) => `bot-${i}-legacy`);
    for (const [i, id] of bots.entries()) user.run(id, `bot-${id}@bots.invalid`, `Bot-${i}`, 'bot:no-sign-in', 1, 5000 + i);
    user.run('member-1', 'm@e2e.dev', 'member', 'scrypt$x', 0, 10000);
    db.prepare("INSERT INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, bots_enabled, bot_level) VALUES ('t1', 'T', 6, 5, 10, 400, 2000, 1, 'hard')").run();
    const before = db.prepare('SELECT id, email, nickname, password_hash, is_bot, balance, status FROM users ORDER BY id').all();

    for (const f of files.slice(at)) apply(db, f);

    expect(db.prepare('SELECT id, email, nickname, password_hash, is_bot, balance, status FROM users ORDER BY id').all()).toEqual(before);
    const table = db.prepare("SELECT bot_level AS level, bot_style AS style FROM tables WHERE id = 't1'").get() as { level: BotLevel; style: BotTableStyle };
    expect(table).toEqual({ level: 'hard', style: 'auto' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_profiles').get()).toEqual({ n: 0 });

    // No profile: each bot plays the table's level and the style it always had, so they stay mixed.
    const plays = bots.map((id) => botPlayOf(id, null, table));
    for (const [i, p] of plays.entries()) expect(p).toEqual({ level: 'hard', levelFrom: 'table', style: styleFor(bots[i]!), styleFrom: 'auto' });
    expect(new Set(plays.map((p) => p.style)).size).toBeGreaterThan(1);

    // A profile row may set one of the two and leave the other to the table; both columns refuse nothing else at the DB,
    // the API checks the values.
    db.prepare("INSERT INTO bot_profiles (bot_id, level, style, updated_by) VALUES (?, 'expert', NULL, 'member-1')").run(bots[0]!);
    const row = db.prepare('SELECT level, style, updated_at AS at FROM bot_profiles WHERE bot_id = ?').get(bots[0]!) as { level: BotLevel; style: null; at: number };
    expect(row.at).toBeGreaterThan(0);
    expect(botPlayOf(bots[0]!, row, table)).toEqual({ level: 'expert', levelFrom: 'bot', style: styleFor(bots[0]!), styleFrom: 'auto' });
    // A profile for an account that does not exist is refused.
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => db.prepare("INSERT INTO bot_profiles (bot_id, level) VALUES ('nobody', 'easy')").run()).toThrow(/FOREIGN KEY/);
  });
});

describe('botPlayOf', () => {
  const table = { level: 'normal' as const, style: 'auto' as const };
  it('takes level and style from the bot one by one, else from the table', () => {
    expect(botPlayOf('b', { level: 'easy', style: 'lag' }, table)).toEqual({ level: 'easy', levelFrom: 'bot', style: 'lag', styleFrom: 'bot' });
    expect(botPlayOf('b', { level: null, style: 'tag' }, table)).toEqual({ level: 'normal', levelFrom: 'table', style: 'tag', styleFrom: 'bot' });
    expect(botPlayOf('b', { level: 'expert', style: null }, { level: 'easy', style: 'loose-passive' })).toEqual({ level: 'expert', levelFrom: 'bot', style: 'loose-passive', styleFrom: 'table' });
    expect(botPlayOf('b', undefined, { level: 'hard', style: 'tight-passive' })).toEqual({ level: 'hard', levelFrom: 'table', style: 'tight-passive', styleFrom: 'table' });
    expect(botPlayOf('b', null, table)).toEqual({ level: 'normal', levelFrom: 'table', style: styleFor('b'), styleFrom: 'auto' });
  });
});
