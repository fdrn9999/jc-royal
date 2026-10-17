import { publicRole } from '@jc/types';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostedBy, MemberName, RoleBadge } from '../src/components/MemberName';
import { I18nProvider } from '../src/lib/i18n';

// The provider reads ?lang= from the address on its first render.
(globalThis as { window?: unknown }).window ??= { location: { search: '' } };
const html = (el: ReactElement) => renderToStaticMarkup(h(I18nProvider, null, el));

describe('publicRole', () => {
  it('passes on only the staff roles', () => {
    expect(publicRole('super_admin')).toBe('super_admin');
    expect(publicRole('admin')).toBe('admin');
    for (const r of ['user', '', null, undefined, 'owner', 'SUPER_ADMIN']) expect(publicRole(r)).toBeUndefined();
  });
});

describe('MemberName', () => {
  it('leaves an ordinary member as they were: no mark, no color, no badge', () => {
    const out = html(h(MemberName, { name: 'river_rat', badge: true, className: 'text-ivory' }));
    expect(out).toContain('river_rat');
    expect(out).toContain('text-ivory');
    expect(out).not.toContain('role-icon');
    expect(out).not.toContain('role-badge');
    expect(out).not.toContain('jc-role-name');
    expect(out).not.toContain('data-role');
  });

  it('gives the super admin the drawn crown, the gold name and, when asked, the SUPER ADMIN badge', () => {
    const out = html(h(MemberName, { name: 'Royal', role: 'super_admin', badge: true }));
    expect(out).toMatch(/<svg[^>]*role="img"[^>]*aria-label="최고 관리자"[^>]*data-role="super_admin"[^>]*data-testid="role-icon"/);
    expect(out).toContain('<title>최고 관리자</title>');
    expect(out).toMatch(/class="min-w-0 truncate jc-role-name" data-role="super_admin">Royal</);
    expect(out).toMatch(/data-testid="role-badge">SUPER ADMIN</);
    // Not the 👑 the table uses for a room's host.
    expect(out).not.toContain('👑');
  });

  it('gives an admin the shield and the ADMIN badge only where the badge is asked for', () => {
    const out = html(h(MemberName, { name: 'Mod', role: 'admin' }));
    expect(out).toMatch(/aria-label="관리자"[^>]*data-role="admin"/);
    expect(out).toContain('jc-role-name');
    expect(out).not.toContain('role-badge');
    expect(html(h(RoleBadge, { role: 'admin' }))).toMatch(/data-role="admin"[^>]*>ADMIN</);
    expect(html(h(RoleBadge, {}))).toBe('');
  });

  it('keeps the mark and the badge outside the part a long name is cut from', () => {
    const out = html(h(MemberName, { name: 'a'.repeat(16), role: 'super_admin', badge: true }));
    const name = out.indexOf('min-w-0 truncate');
    expect(out.indexOf('role-icon')).toBeLessThan(name);
    expect(out.indexOf('role-badge')).toBeGreaterThan(out.indexOf('a'.repeat(16)));
  });

  it('marks a table bot with the BOT pill after the name, its level for screen readers and on hover', () => {
    const out = html(h(MemberName, { name: 'Bot-K4P2', bot: 'hard' }));
    expect(out).toMatch(/data-level="hard" data-testid="bot-badge"><span aria-hidden="true">BOT<\/span><span class="sr-only">테이블 봇 · 어려움<\/span>/);
    expect(out).toContain('title="테이블 봇 · 어려움"');
    expect(out.indexOf('bot-badge')).toBeGreaterThan(out.indexOf('Bot-K4P2'));
    // Not a staff member, and no badge flag needed: a bot is always marked.
    expect(out).not.toContain('jc-role-name');
    expect(out).not.toContain('role-badge');
  });

  it('marks a bot of a past hand (level not recorded) without a level, and members not at all', () => {
    const out = html(h(MemberName, { name: 'Bot-K4P2', bot: true }));
    expect(out).toContain('<span class="sr-only">테이블 봇</span>');
    expect(out).not.toContain('data-level');
    expect(html(h(MemberName, { name: 'river_rat' }))).not.toContain('bot-badge');
  });
});

describe('HostedBy', () => {
  it('colors only the name inside the translated sentence', () => {
    expect(html(h(HostedBy, { host: { nickname: 'Royal', role: 'super_admin' } }))).toMatch(/방장 <span class="jc-role-name" data-role="super_admin">Royal<\/span>/);
    const member = html(h(HostedBy, { host: { nickname: 'Joe' } }));
    expect(member).toContain('👤');
    expect(member).toMatch(/방장 <span>Joe<\/span>/);
  });
});
