import { describe, expect, it } from 'vitest';
import {
  BOARD_TEMPLATES,
  MAINTENANCE_TEMPLATES,
  MESSAGE_TEMPLATES,
  NOTICE_TEMPLATES,
  REASONS,
  SEP,
  VARS,
  byKind,
  composeReason,
  fill,
  flatten,
  formatMoment,
  formatPeriod,
  maintenanceVars,
  matchReason,
  overLimit,
  part,
  readReason,
  unfilled,
  varOf,
  type AdminTemplate,
} from '../src/adminTemplates';

/** Every reason list, however deep it sits in REASONS. */
function reasonLists(node: unknown, path = 'REASONS'): [string, AdminTemplate[]][] {
  if (Array.isArray(node)) return [[path, node as AdminTemplate[]]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => reasonLists(v, `${path}.${k}`));
}
const lists = reasonLists(REASONS);
const reasons = lists.flatMap(([, l]) => l);
const contents = [...NOTICE_TEMPLATES, ...MAINTENANCE_TEMPLATES, ...BOARD_TEMPLATES, ...Object.values(MESSAGE_TEMPLATES).flat()];
const texts = (t: AdminTemplate) => [t.titleKo, t.titleEn, t.bodyKo, t.bodyEn].filter((x): x is string => x !== undefined);

describe('template data', () => {
  it('gives every template one id, and the same id the same template wherever it is listed', () => {
    const byId = new Map<string, AdminTemplate>();
    for (const t of [...reasons, ...contents]) {
      const seen = byId.get(t.id);
      if (seen) expect(seen, t.id).toBe(t);
      byId.set(t.id, t);
    }
    expect(new Set(contents.map((t) => t.id)).size).toBe(contents.length);
  });

  it('labels every template in Korean and English', () => {
    for (const t of [...reasons, ...contents]) {
      expect(t.labelKo.trim(), t.id).not.toBe('');
      expect(t.labelEn.trim(), t.id).not.toBe('');
    }
  });

  it('keeps reasons within what the API takes, so a reason with room for a detail can be sent', () => {
    for (const t of reasons) {
      for (const l of [t.labelKo, t.labelEn]) {
        expect(l.length, t.id).toBeGreaterThanOrEqual(2);
        expect(l.length + SEP.length + 20, t.id).toBeLessThanOrEqual(200);
        expect(l.includes(SEP), t.id).toBe(false);
      }
    }
  });

  it('labels each list without repeats, so a reason picked reads back as the same one', () => {
    for (const [path, list] of lists) {
      for (const lang of ['ko', 'en'] as const) {
        const ls = list.map((t) => (lang === 'en' ? t.labelEn : t.labelKo));
        expect(new Set(ls).size, `${path} ${lang}`).toBe(ls.length);
      }
    }
  });

  it('keeps grants and deductions apart', () => {
    const grant = new Set(REASONS.chipGrant.map((t) => t.labelKo));
    expect(REASONS.chipDeduct.filter((t) => grant.has(t.labelKo))).toEqual([]);
    expect(REASONS.chipGrant.every((t) => t.id.startsWith('chip.grant.'))).toBe(true);
    expect(REASONS.chipDeduct.every((t) => t.id.startsWith('chip.deduct.'))).toBe(true);
  });

  it('says a table-control reason is for the action it is listed under', () => {
    for (const [action, list] of Object.entries(REASONS.control)) for (const t of list) expect(t.action, t.id).toBe(action);
  });

  it('asks for a detail with each suspension reason that states a breach', () => {
    const states = REASONS.suspend.filter((t) => ['suspend.cheating', 'suspend.multi', 'suspend.play', 'suspend.harass', 'suspend.terms', 'suspend.policy'].includes(t.id));
    expect(states).toHaveLength(6);
    expect(states.every((t) => t.detailRequired)).toBe(true);
  });

  it('files an integrity review as a request to look, never as a finding', () => {
    for (const t of REASONS.integrity) expect(t.labelKo, t.id).not.toMatch(/확인됨|확정|적발/);
  });

  it('writes in braces only values the admin can fill', () => {
    for (const t of contents)
      for (const s of texts(t))
        for (const m of s.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) expect(varOf(m[1]!), `${t.id}: ${m[0]}`).toBeDefined();
  });

  it('puts a value written in one language only into the text in that language', () => {
    for (const t of contents) {
      for (const [s, lang] of [
        [t.titleKo, 'ko'],
        [t.bodyKo, 'ko'],
        [t.titleEn, 'en'],
        [t.bodyEn, 'en'],
      ] as const) {
        for (const key of unfilled([s])) {
          const v = varOf(key)!;
          if (v.lang) expect(v.lang, `${t.id} ${lang}: {${key}}`).toBe(lang);
        }
      }
    }
  });

  it('asks the same things in Korean and in English', () => {
    const base = (k: string) => (k.endsWith('En') && varOf(k)?.lang === 'en' ? k.slice(0, -2) : k);
    for (const t of contents) {
      const ko = unfilled([t.titleKo, t.bodyKo]).map(base).sort();
      const en = unfilled([t.titleEn, t.bodyEn]).map(base).sort();
      expect(en, t.id).toEqual(ko);
    }
  });

  it('fills every field a form has, within its limits', () => {
    for (const t of NOTICE_TEMPLATES) {
      for (const s of [t.titleKo, t.titleEn]) expect(s && s.length >= 2 && s.length <= 100, t.id).toBe(true);
      for (const s of [t.bodyKo, t.bodyEn]) expect(s && s.length <= 2000, t.id).toBe(true);
    }
    for (const t of MAINTENANCE_TEMPLATES) {
      expect(t.titleKo, t.id).toBeUndefined();
      for (const s of [t.bodyKo, t.bodyEn]) expect(s && s.length <= 2000, t.id).toBe(true);
    }
    for (const t of BOARD_TEMPLATES) {
      for (const s of [t.titleKo, t.titleEn]) expect(s && s.length >= 2 && s.length <= 100, t.id).toBe(true);
      for (const s of [t.bodyKo, t.bodyEn]) expect(s && s.length <= 10_000, t.id).toBe(true);
    }
    for (const t of Object.values(MESSAGE_TEMPLATES).flat()) {
      for (const s of [t.titleKo, t.titleEn]) expect(s && s.length <= 100, t.id).toBe(true);
      for (const s of [t.bodyKo, t.bodyEn]) expect(s && s.length <= 2000, t.id).toBe(true);
    }
  });

  it('writes every time a maintenance message asks for from the form, and lets a notice ask for it instead', () => {
    const written = Object.keys(maintenanceVars(0, 3_600_000));
    for (const t of MAINTENANCE_TEMPLATES)
      for (const key of unfilled(texts(t))) if (varOf(key)!.auto) expect(written, `${t.id}: {${key}}`).toContain(key);
    // A notice or board post has no times of its own: the admin types them, with an example to follow.
    for (const x of VARS.filter((y) => y.auto)) {
      expect(written, x.key).toContain(x.key);
      expect(x.hintKo && x.hintEn, x.key).toBeTruthy();
    }
    expect(NOTICE_TEMPLATES.some((t) => unfilled(texts(t)).includes('period'))).toBe(true);
  });

  it('offers no maintenance message for after the window, since none is shown then', () => {
    expect(MAINTENANCE_TEMPLATES.map((t) => t.id)).not.toContain('maint.done');
    expect(NOTICE_TEMPLATES.map((t) => t.id)).toContain('notice.maintDone');
  });

  it('writes the samples the brief gave', () => {
    const feature = NOTICE_TEMPLATES.find((t) => t.id === 'notice.feature')!;
    expect(feature.titleKo).toBe('[업데이트] JC ROYAL 신규 기능 안내');
    expect(feature.titleEn).toBe('[Update] New Features in JC ROYAL');
    expect(feature.bodyKo).toContain('■ 업데이트 내용\n{updateDetails}');
    expect(feature.bodyEn).toContain("■ What's New\n{updateDetailsEn}");
    const incident = NOTICE_TEMPLATES.find((t) => t.id === 'notice.incident')!;
    expect(unfilled([incident.bodyKo])).toEqual(['incidentTime', 'affectedServices', 'status']);
  });
});

describe('reasons', () => {
  const event = REASONS.chipGrant[0]!;
  const cheating = REASONS.suspend.find((t) => t.id === 'suspend.cheating')!;

  it('records the label, or the label and the detail', () => {
    expect(composeReason(event, '', 'ko')).toBe('이벤트 보상 지급');
    expect(composeReason(event, '  ', 'ko')).toBe('이벤트 보상 지급');
    expect(composeReason(event, '10월 출석', 'ko')).toBe('이벤트 보상 지급 - 10월 출석');
    expect(composeReason(event, 'October check-in', 'en')).toBe('Event reward - October check-in');
  });

  it('records nothing while a required detail is missing', () => {
    expect(composeReason(cheating, '', 'ko')).toBe('');
    expect(composeReason(cheating, '핸드 #12 칩 넘기기', 'ko')).toBe('부정행위 확인 - 핸드 #12 칩 넘기기');
  });

  it('reads a reason back to its template and detail', () => {
    expect(matchReason(REASONS.chipGrant, '이벤트 보상 지급', 'ko')).toEqual({ tpl: event, detail: '' });
    expect(matchReason(REASONS.chipGrant, '이벤트 보상 지급 - 10월 출석', 'ko')).toEqual({ tpl: event, detail: '10월 출석' });
    expect(matchReason(REASONS.chipGrant, '이벤트 보상 지급분', 'ko')).toBeNull();
    expect(matchReason(REASONS.chipGrant, '무료 보충 #1 회수', 'ko')).toBeNull();
    expect(matchReason(REASONS.chipDeduct, '이벤트 보상 지급', 'ko')).toBeNull();
  });

  it('reads a reason in the language it was written in, whatever the console shows now', () => {
    // Written in Korean, then the console switched to English: the detail is still found, with its language.
    expect(readReason(REASONS.chipGrant, '이벤트 보상 지급 - 10월 출석', 'en')).toEqual({ tpl: event, detail: '10월 출석', lang: 'ko' });
    expect(readReason(REASONS.chipGrant, 'Event reward - October check-in', 'ko')).toEqual({ tpl: event, detail: 'October check-in', lang: 'en' });
    expect(readReason(REASONS.chipGrant, '이벤트 보상 지급', 'ko')).toEqual({ tpl: event, detail: '', lang: 'ko' });
    expect(readReason(REASONS.chipGrant, '무료 보충 #1 회수', 'en')).toBeNull();
  });

  it('groups templates suited to a notice kind first, without dropping any', () => {
    const groups = byKind(NOTICE_TEMPLATES, 'urgent', { suited: 'S', others: 'O' });
    expect(groups.map((g) => g.label)).toEqual(['S', 'O']);
    expect(groups[0]!.items.map((t) => t.id)).toEqual(['notice.incident', 'notice.resolved', 'notice.emergency']);
    expect(flatten(groups)).toHaveLength(NOTICE_TEMPLATES.length);
    expect(byKind(NOTICE_TEMPLATES, 'maintenance', { suited: 'S', others: 'O' })[0]!.items[0]!.id).toBe('notice.maintenance');
  });
});

describe('blanks', () => {
  it('fills the values given and leaves the rest in braces', () => {
    expect(fill('■ {eventName}\n■ {reward}', { eventName: '출석 이벤트', reward: '  ' })).toBe('■ 출석 이벤트\n■ {reward}');
    expect(unfilled(['■ 출석 이벤트\n■ {reward}', '{reward} {eventPeriod}'])).toEqual(['reward', 'eventPeriod']);
  });

  it('leaves braces that are not a known value alone', () => {
    expect(fill('{json} {eventName}', { json: 'x', eventName: 'y' })).toBe('{json} y');
    expect(unfilled(['{json} { eventName }', null, undefined])).toEqual([]);
  });

  it('finds nothing left in a template once every value is given', () => {
    const vars = Object.fromEntries(VARS.map((v) => [v.key, `<${v.key}>`]));
    for (const t of contents) expect(unfilled(texts(t).map((s) => fill(s, vars))), t.id).toEqual([]);
  });

  it('finds the fields longer than the server takes, counted as it counts them', () => {
    const limits = { title: 100, body: 2000 };
    expect(overLimit({ title: 'x'.repeat(100), body: 'y'.repeat(2000) }, limits)).toEqual([]);
    // The server trims first: spaces around the text do not count.
    expect(overLimit({ title: ` ${'x'.repeat(100)} `, body: '' }, limits)).toEqual([]);
    expect(overLimit({ title: 'x'.repeat(101), body: 'y'.repeat(2001) }, limits)).toEqual([
      { key: 'title', length: 101, max: 100 },
      { key: 'body', length: 2001, max: 2000 },
    ]);
    // A field the form does not have is not counted.
    expect(overLimit({ title: 'x' }, { title: 100, body: 2000 })).toEqual([]);
  });

  it('can write more than a notice takes when long values go into a template, which the form then finds', () => {
    // Each value field takes 1,000 characters; two of them in the event notice pass the 2,000 a body may hold.
    const ev = NOTICE_TEMPLATES.find((t) => t.id === 'notice.event')!;
    const long = { eventName: '출석', eventPeriod: '10월', participation: 'p'.repeat(1000), reward: 'r'.repeat(1000) };
    const bodyKo = fill(ev.bodyKo!, long);
    expect(unfilled([bodyKo])).toEqual([]);
    expect(overLimit({ bodyKo }, { bodyKo: 2000 })).toEqual([{ key: 'bodyKo', length: bodyKo.trim().length, max: 2000 }]);
  });

  it('reads a part in the language asked', () => {
    const t = NOTICE_TEMPLATES[0]!;
    expect(part(t, 'title', 'en')).toBe(t.titleEn);
    expect(part(t, 'body', 'ko')).toBe(t.bodyKo);
    expect(part(MAINTENANCE_TEMPLATES[0]!, 'title', 'ko')).toBe('');
  });
});

describe('maintenance times', () => {
  // 2026-10-28T17:00Z = 10월 29일 02:00 in Korea.
  const start = Date.UTC(2026, 9, 28, 17, 0);
  const h = 3_600_000;

  it('writes a window in Korea time, the date once when it is one day', () => {
    expect(formatPeriod(start, start + 2 * h, 'ko')).toBe('2026년 10월 29일 02:00 ~ 04:00 (KST)');
    expect(formatPeriod(start, start + 2 * h, 'en')).toBe('Oct 29, 2026 02:00 – 04:00 (KST)');
  });

  it('writes the end date when it falls on another day, and the year when that changes too', () => {
    expect(formatPeriod(start, start + 23 * h, 'ko')).toBe('2026년 10월 29일 02:00 ~ 10월 30일 01:00 (KST)');
    const nye = Date.UTC(2026, 11, 31, 14, 0); // 12월 31일 23:00 KST
    expect(formatPeriod(nye, nye + 2 * h, 'ko')).toBe('2026년 12월 31일 23:00 ~ 2027년 1월 1일 01:00 (KST)');
    expect(formatPeriod(nye, nye + 2 * h, 'en')).toBe('Dec 31, 2026 23:00 – Jan 1, 2027 01:00 (KST)');
  });

  it('writes one moment', () => {
    expect(formatMoment(start + 2 * h, 'ko')).toBe('2026년 10월 29일 04:00 (KST)');
    expect(formatMoment(start + 2 * h, 'en')).toBe('Oct 29, 2026 04:00 (KST)');
  });

  it('gives no times until both are set and in order', () => {
    expect(maintenanceVars(null, start)).toEqual({ period: '', periodEn: '', endAt: '', endAtEn: '' });
    expect(maintenanceVars(start, start)).toEqual({ period: '', periodEn: '', endAt: '', endAtEn: '' });
    const v = maintenanceVars(start, start + 2 * h);
    expect(v.period).toBe('2026년 10월 29일 02:00 ~ 04:00 (KST)');
    expect(v.endAtEn).toBe('Oct 29, 2026 04:00 (KST)');
    for (const key of Object.keys(v)) expect(varOf(key)?.auto, key).toBe(true);
  });
});
