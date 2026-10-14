import { PLAYER_REPORT_WINDOW_MS, PRIVACY_NOTICE_VERSION } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { LEGAL_DRAFT, POLICY_DRAFT_DATE, PRIVACY_POLICY, TERMS } from '../src/legal/policies';
import { PRIVACY_NOTICE } from '../src/legal/privacyNotice';

const docs = { notice: PRIVACY_NOTICE, privacy: PRIVACY_POLICY, terms: TERMS };
const text = (d: { intro: string; sections: { heading: string; items: string[] }[] }) =>
  [d.intro, ...d.sections.flatMap((s) => [s.heading, ...s.items])].join('\n');

describe('legal texts', () => {
  it.each(Object.entries(docs))('%s: Korean and English have the same structure', (_, doc) => {
    const { ko, en } = doc;
    expect(ko.sections.length).toBeGreaterThan(0);
    expect(en.sections.length).toBe(ko.sections.length);
    ko.sections.forEach((s, i) => {
      const e = en.sections[i]!;
      expect(s.items.length, `${s.heading} / ${e.heading}`).toBe(e.items.length);
      expect([s.heading, e.heading, ...s.items, ...e.items].every((x) => x.trim().length > 0)).toBe(true);
      // A point left open for legal review is open in both languages.
      expect(Boolean((e as { review?: string }).review), s.heading).toBe(Boolean((s as { review?: string }).review));
    });
  });

  it('signup notice shows the version members accept', () => {
    const [y, m, d] = PRIVACY_NOTICE_VERSION.split('-').map(Number);
    expect(PRIVACY_NOTICE.en.effective).toContain(PRIVACY_NOTICE_VERSION);
    expect(PRIVACY_NOTICE.ko.effective).toContain(`${y}년 ${m}월 ${d}일`);
  });

  it('policy pages are marked as drafts, with open points instead of decided ones', () => {
    for (const locale of ['ko', 'en'] as const) {
      expect(LEGAL_DRAFT[locale].length).toBeGreaterThan(0);
      for (const doc of [PRIVACY_POLICY[locale], TERMS[locale]]) {
        expect(doc.sections.some((s) => s.review)).toBe(true);
      }
    }
    const [y, m, d] = POLICY_DRAFT_DATE.split('-').map(Number);
    expect(PRIVACY_POLICY.ko.effective).toContain(`${y}년 ${m}월 ${d}일`);
    expect(PRIVACY_POLICY.en.effective).toContain(POLICY_DRAFT_DATE);
  });

  it('describes passwords and codes as hashed, not as reversible encryption', () => {
    for (const doc of [PRIVACY_NOTICE.ko, PRIVACY_POLICY.ko]) {
      expect(text(doc)).not.toContain('암호화해 저장');
      expect(text(doc)).toContain('해시');
    }
    for (const doc of [PRIVACY_NOTICE.en, PRIVACY_POLICY.en]) {
      expect(text(doc)).not.toContain('stored encrypted');
      expect(text(doc)).toContain('hash');
    }
  });

  it('covers the new social data and what account deletion removes', () => {
    const ko = text(PRIVACY_NOTICE.ko) + text(PRIVACY_POLICY.ko);
    const en = text(PRIVACY_NOTICE.en) + text(PRIVACY_POLICY.en);
    for (const w of ['1:1 대화', '친구', '차단', '신고', '탈퇴한 회원', '정리 작업']) expect(ko).toContain(w);
    for (const w of ['1:1 messages', 'friends', 'block', 'report', 'Withdrawn member', 'clean-up job']) expect(en).toContain(w);
  });

  it('chat retention matches the player report window', () => {
    const hours = PLAYER_REPORT_WINDOW_MS / 3_600_000;
    expect(text(PRIVACY_POLICY.ko)).toContain(`닫힌 뒤 ${hours}시간`);
    expect(text(PRIVACY_POLICY.en)).toContain(`${hours} hours after the table closes`);
  });
});
