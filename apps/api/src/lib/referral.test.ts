import { normalizeReferralCode, REFERRAL_CODE_RE } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { REFERRAL_HANDS_DAYS, newReferralCode, networkOf, normalizeEmail, planSettlement, policyIssue, type SettleFacts } from './referral';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 3);

/** A pending referral both of whose members are active, under a policy that is on and not paused, nothing paid yet. */
const facts = (over: Partial<SettleFacts> = {}): SettleFacts => ({
  status: 'pending',
  referrerStatus: 'pending',
  inviteeStatus: 'pending',
  minHands: 1,
  createdAt: NOW - DAY,
  policy: { paused: false, dailyCap: 5, totalCap: 50 },
  invitee: 'active',
  referrer: 'active',
  hands: 1,
  paidToday: 0,
  paidTotal: 0,
  now: NOW,
  ...over,
});

describe('referral codes', () => {
  it('makes codes the signup form and the link accept, without letters that read alike', () => {
    const codes = Array.from({ length: 500 }, newReferralCode);
    for (const c of codes) {
      expect(c).toMatch(REFERRAL_CODE_RE);
      expect(c).toHaveLength(7);
      expect(c.slice(2)).not.toMatch(/[01IO]/);
    }
    // 32^5 codes: 500 of them practically never repeat (a repeat is retried by referralCodeOf anyway).
    expect(new Set(codes).size).toBeGreaterThan(495);
  });

  it('reads a code as typed or pasted, and refuses anything else', () => {
    expect(normalizeReferralCode(' jc7k 4p2\n')).toBe('JC7K4P2');
    expect(REFERRAL_CODE_RE.test(normalizeReferralCode('jc7k4p2'))).toBe(true);
    for (const bad of ['', 'JC', 'JC123', 'XX7K4P2', 'JC7K4P2-', 'JC7K4P2X12345', "JC7K4P2' OR 1=1"]) {
      expect(REFERRAL_CODE_RE.test(normalizeReferralCode(bad)), bad).toBe(false);
    }
  });
});

describe('normalizeEmail', () => {
  it('treats aliases of one inbox as the same inbox', () => {
    expect(normalizeEmail(' Some.One+promo@Gmail.com ')).toBe('someone@gmail.com');
    expect(normalizeEmail('some.one@googlemail.com')).toBe('someone@gmail.com');
    expect(normalizeEmail('someone+a+b@gmail.com')).toBe('someone@gmail.com');
    // Dots matter outside Gmail; tags are dropped everywhere.
    expect(normalizeEmail('some.one+x@example.com')).toBe('some.one@example.com');
    expect(normalizeEmail('some.one@example.com')).not.toBe(normalizeEmail('someone@example.com'));
  });

  it('leaves a value with no local part alone', () => {
    expect(normalizeEmail('@example.com')).toBe('@example.com');
    expect(normalizeEmail('nobody')).toBe('nobody');
  });
});

describe('networkOf', () => {
  it('keeps an IPv4 address whole and an IPv6 address to its /64', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7');
    expect(networkOf('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:0DB8:0001:0002:aaaa::1')).toBe('2001:db8:1:2::/64');
    // Two devices of one home share the /64; another home does not.
    expect(networkOf('2001:db8:1:2::abcd')).toBe(networkOf('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(networkOf('2001:db8:1:3::1')).not.toBe(networkOf('2001:db8:1:2::1'));
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkOf('::1')).toBe('0:0:0:0::/64');
  });
});

describe('policyIssue', () => {
  const base = { enabled: true, referrerAmount: 1000, inviteeAmount: 1000, dailyCap: 5, totalCap: 50 };
  it('refuses a policy that is on but pays nobody, and a daily cap above the total cap', () => {
    expect(policyIssue(base)).toBeNull();
    expect(policyIssue({ ...base, referrerAmount: 0, inviteeAmount: 0 })).toBe('referral_nothing_to_pay');
    expect(policyIssue({ ...base, enabled: false, referrerAmount: 0, inviteeAmount: 0 })).toBeNull();
    expect(policyIssue({ ...base, referrerAmount: 0 })).toBeNull();
    expect(policyIssue({ ...base, dailyCap: 51 })).toBe('referral_caps_order');
    expect(policyIssue({ ...base, dailyCap: 50 })).toBeNull();
  });
});

describe('planSettlement', () => {
  it('pays both sides when everything holds', () => {
    expect(planSettlement(facts())).toEqual({ close: false, invitee: 'pay', referrer: 'pay', failure: null });
  });

  it('moves only pending referrals: one under review, settled or closed is left alone', () => {
    for (const status of ['review', 'settled', 'unpaid'] as const) expect(planSettlement(facts({ status }))).toBeNull();
  });

  it('closes when the new member left, or did not finish the hands in time', () => {
    expect(planSettlement(facts({ invitee: 'deleted' }))).toMatchObject({ close: true, failure: 'invitee_deleted' });
    expect(planSettlement(facts({ invitee: null }))).toMatchObject({ close: true, failure: 'invitee_deleted' });
    const late = NOW - REFERRAL_HANDS_DAYS * DAY - 1;
    expect(planSettlement(facts({ hands: 0, createdAt: late }))).toMatchObject({ close: true, failure: 'hands' });
    // On the last day it still waits; with the hands done, time does not matter.
    expect(planSettlement(facts({ hands: 0, createdAt: NOW - REFERRAL_HANDS_DAYS * DAY }))).toEqual({ close: false, invitee: null, referrer: null, failure: 'hands' });
    expect(planSettlement(facts({ hands: 1, createdAt: late }))).toMatchObject({ close: false, invitee: 'pay', referrer: 'pay' });
  });

  it('waits, paying nothing, while there is no policy, payouts are paused, the new member is suspended or the hands are due', () => {
    const wait = (failure: string) => ({ close: false, invitee: null, referrer: null, failure });
    expect(planSettlement(facts({ policy: null }))).toEqual(wait('off'));
    expect(planSettlement(facts({ policy: { paused: true, dailyCap: 5, totalCap: 50 } }))).toEqual(wait('paused'));
    expect(planSettlement(facts({ invitee: 'suspended' }))).toEqual(wait('invitee_suspended'));
    expect(planSettlement(facts({ minHands: 3, hands: 2 }))).toEqual(wait('hands'));
    expect(planSettlement(facts({ minHands: 0, hands: 0 }))).toMatchObject({ invitee: 'pay', referrer: 'pay' });
  });

  it('pays the new member even when the referrer cannot be paid', () => {
    expect(planSettlement(facts({ referrer: 'deleted' }))).toEqual({ close: false, invitee: 'pay', referrer: 'skipped', failure: 'referrer_deleted' });
    expect(planSettlement(facts({ referrer: null }))).toMatchObject({ invitee: 'pay', referrer: 'skipped' });
    // Skipped when the referrer withdrew (auth.ts): the reason stays while the new member is paid.
    expect(planSettlement(facts({ referrer: 'deleted', referrerStatus: 'skipped' }))).toEqual({ close: false, invitee: 'pay', referrer: null, failure: 'referrer_deleted' });
    expect(planSettlement(facts({ paidTotal: 50 }))).toEqual({ close: false, invitee: 'pay', referrer: 'capped', failure: 'total_cap' });
    expect(planSettlement(facts({ paidToday: 5 }))).toEqual({ close: false, invitee: 'pay', referrer: 'capped', failure: 'daily_cap' });
    // Both caps reached: the total cap is the reason (it does not lift tomorrow).
    expect(planSettlement(facts({ paidToday: 5, paidTotal: 50 }))).toMatchObject({ failure: 'total_cap' });
    expect(planSettlement(facts({ paidToday: 4, paidTotal: 49 }))).toMatchObject({ referrer: 'pay', failure: null });
    // A suspended referrer waits (the side stays pending) while the new member is paid.
    expect(planSettlement(facts({ referrer: 'suspended' }))).toEqual({ close: false, invitee: 'pay', referrer: null, failure: 'referrer_suspended' });
  });

  it('never pays a side twice or a side that pays nothing', () => {
    expect(planSettlement(facts({ inviteeStatus: 'paid' }))).toMatchObject({ invitee: null, referrer: 'pay' });
    expect(planSettlement(facts({ referrerStatus: 'paid' }))).toEqual({ close: false, invitee: 'pay', referrer: null, failure: null });
    expect(planSettlement(facts({ inviteeStatus: 'skipped', referrerStatus: 'capped' }))).toEqual({ close: false, invitee: null, referrer: null, failure: null });
    // A referrer already final is not re-capped by today's count.
    expect(planSettlement(facts({ referrerStatus: 'paid', paidToday: 9, paidTotal: 99 }))).toMatchObject({ referrer: null, failure: null });
  });
});
