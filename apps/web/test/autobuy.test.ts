import { AutoBuyRequestSchema, type AutoBuyPolicy, type TableView } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { autoBuyEstimate, draftFrom, draftRequest, editDraft, seatPolicy } from '../src/game/autoBuy';

const table = { minBuyIn: 1_000, maxBuyIn: 10_000 };
const topup = (p: Partial<Extract<AutoBuyPolicy, { mode: 'topup' }>> = {}): AutoBuyPolicy => ({ mode: 'topup', target: 5_000, trigger: 4_000, partial: false, cap: 25_000, spent: 0, ...p });
const rebuy = (p: Partial<Extract<AutoBuyPolicy, { mode: 'rebuy' }>> = {}): AutoBuyPolicy => ({ mode: 'rebuy', amount: 2_000, cap: 6_000, spent: 0, ...p });

describe('autoBuyEstimate: what the room would take after the hand (room.ts autoRebuy / autoTopUp)', () => {
  it('top-up: the spec example, target 5,000 below 4,000, a stack of 3,200 takes 1,800', () => {
    expect(autoBuyEstimate(topup(), 3_200, table, 50_000)).toEqual({ amount: 1_800 });
  });
  it('top-up: nothing at or above the trigger, or with the target met', () => {
    expect(autoBuyEstimate(topup(), 4_000, table, 50_000)).toEqual({ amount: 0 });
    expect(autoBuyEstimate(topup(), 5_000, table, 50_000)).toEqual({ amount: 0 });
    expect(autoBuyEstimate(topup({ trigger: 5_000 }), 5_000, table, 50_000)).toEqual({ amount: 0 });
    expect(autoBuyEstimate(topup({ trigger: 5_000 }), 4_999, table, 50_000)).toEqual({ amount: 1 });
  });
  it('top-up: from 0 it restores the whole target, never above the table maximum', () => {
    expect(autoBuyEstimate(topup(), 0, table, 50_000)).toEqual({ amount: 5_000 });
    expect(autoBuyEstimate(topup({ target: 12_000, trigger: 12_000, cap: 60_000 }), 0, table, 50_000)).toEqual({ amount: 10_000 });
  });
  it('top-up: a short wallet stops it, unless partial top-ups are on and what it holds reaches the minimum', () => {
    expect(autoBuyEstimate(topup(), 3_200, table, 1_000)).toEqual({ amount: 0, stop: 'short' });
    expect(autoBuyEstimate(topup({ partial: true }), 3_200, table, 1_000)).toEqual({ amount: 1_000 });
    expect(autoBuyEstimate(topup({ partial: true }), 0, table, 999)).toEqual({ amount: 0, stop: 'short' });
    expect(autoBuyEstimate(topup({ partial: true }), 0, table, 0)).toEqual({ amount: 0, stop: 'short' });
  });
  it('top-up: past its limit, or a target the table no longer allows, stops it', () => {
    expect(autoBuyEstimate(topup({ spent: 24_000 }), 3_200, table, 50_000)).toEqual({ amount: 0, stop: 'cap' });
    expect(autoBuyEstimate(topup({ spent: 23_200 }), 3_200, table, 50_000)).toEqual({ amount: 1_800 });
    expect(autoBuyEstimate(topup(), 0, { minBuyIn: 6_000, maxBuyIn: 10_000 }, 50_000)).toEqual({ amount: 0, stop: 'cap' });
  });
  it('rebuy: only at 0; its amount, within the table maximum and its limit', () => {
    expect(autoBuyEstimate(rebuy(), 1, table, 50_000)).toEqual({ amount: 0 });
    expect(autoBuyEstimate(rebuy(), 0, table, 50_000)).toEqual({ amount: 2_000 });
    expect(autoBuyEstimate(rebuy({ spent: 6_000 }), 0, table, 50_000)).toEqual({ amount: 0, stop: 'cap' });
    expect(autoBuyEstimate(rebuy(), 0, table, 1_999)).toEqual({ amount: 0, stop: 'short' });
  });
});

describe('the draft a player edits', () => {
  it('starts off, with no consent, and sends nothing for a policy until consent is given', () => {
    const d = draftFrom(null, 'off', 3_000);
    expect(draftRequest(d)).toEqual({ mode: 'off' });
    const t = draftFrom(null, 'topup', 3_000);
    expect(t).toMatchObject({ target: 3_000, trigger: 3_000, partial: false, times: 1, consent: false });
    expect(draftRequest(t)).toBeNull();
    expect(draftRequest(editDraft(t, { consent: true }))).toEqual({ mode: 'topup', target: 3_000, trigger: 3_000, partial: false, cap: 3_000, consent: true });
  });
  it('withdraws consent on any change of terms; a trigger that was the target follows it, and none goes above it', () => {
    const t = editDraft(draftFrom(null, 'topup', 3_000), { consent: true });
    const moved = editDraft(t, { target: 5_000 });
    expect(moved).toMatchObject({ target: 5_000, trigger: 5_000, consent: false });
    const own = editDraft(moved, { trigger: 4_000 });
    expect(editDraft(own, { target: 6_000 }).trigger).toBe(4_000);
    expect(editDraft(own, { target: 3_500 }).trigger).toBe(3_500);
    expect(editDraft(own, { times: 3 }).consent).toBe(false);
    expect(editDraft(own, { partial: true }).consent).toBe(false);
  });
  it('every request it makes is one the room accepts the shape of', () => {
    for (const d of [
      editDraft(draftFrom(null, 'rebuy', 2_000), { times: 5, consent: true }),
      editDraft(editDraft(draftFrom(null, 'topup', 5_000), { trigger: 4_000, partial: true, times: 3 }), { consent: true }),
      draftFrom(null, 'off', 1),
    ]) {
      expect(AutoBuyRequestSchema.safeParse(draftRequest(d)).success).toBe(true);
    }
  });
  it('changing a held policy starts from its terms, with consent to give again', () => {
    expect(draftFrom(topup({ partial: true }), 'topup', 1_000)).toMatchObject({ mode: 'topup', target: 5_000, trigger: 4_000, partial: true, times: 5, consent: false });
    expect(draftFrom(rebuy(), 'rebuy', 1_000)).toMatchObject({ mode: 'rebuy', amount: 2_000, times: 3, consent: false });
  });
});

describe('seatPolicy', () => {
  const you = (p: Partial<TableView['you']>) => ({ seatIndex: 0, autoRebuy: null, ...p }) as TableView['you'];
  it('reads the policy, and a rebuy from a room older than automatic top-ups', () => {
    expect(seatPolicy(you({ autoBuy: topup() }))).toMatchObject({ mode: 'topup' });
    expect(seatPolicy(you({ autoBuy: null, autoRebuy: { amount: 1, cap: 1, spent: 0 } }))).toBeNull();
    expect(seatPolicy(you({ autoRebuy: { amount: 2_000, cap: 6_000, spent: 0 } }))).toEqual(rebuy());
    expect(seatPolicy(you({}))).toBeNull();
  });
});
