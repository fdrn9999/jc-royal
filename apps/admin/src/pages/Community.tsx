import { Badge, Button, Field, formatDate, Input, MessageCircleIcon, Panel, PinIcon, XIcon } from '@jc/ui';
import { useState, type FormEvent } from 'react';
import { BOARD_TEMPLATES, MESSAGE_TEMPLATES, type MessageCategory } from '../adminTemplates';
import { useT } from '../i18n';
import { categoryLabel, contentStatusLabel, type Tr } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { ContentTemplateFields, TemplateMissing, TemplatePreview, TemplateTooLong, useContentTemplate } from '../templateFields';
import { contentTone, Feedback, ListState, LoadError, Modal, Pager, type Note } from '../ui';
import { LangBadge } from './Console';

const BOARD_PAGE = 50;
const HISTORY_PAGE = 20;
const selectCls = 'h-10 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';

/** An offset page of the API (board posts, sent messages): `more` when another page follows it. */
interface OffsetPage<T> {
  items: T[];
  limit: number;
  offset: number;
  more: boolean;
}

/** A failed action, unless the administrator closed the password prompt themselves. */
const failNote = (e: unknown, t: Tr): Note => (e instanceof ApiError && e.code === 'reauth_cancelled' ? null : { ok: false, text: errText(e, t) });

interface AdminPost {
  id: string;
  title: string;
  isNotice: boolean;
  status: 'visible' | 'hidden' | 'deleted';
  author: { id: string; nickname: string; isAdmin: boolean; withdrawn?: true };
  commentCount: number;
  viewCount: number;
  handCount: number;
  createdAt: number;
}

export function BoardAdminPage() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [filter, setFilter] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ paged: '1', limit: String(BOARD_PAGE) });
  if (filter) params.set('status', filter);
  if (q) params.set('q', q);
  if (offset) params.set('offset', String(offset));
  const { data, error, loading, reload } = useData<OffsetPage<AdminPost>>(`/api/admin/board/posts?${params}`);
  const [notice, setNotice] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [del, setDel] = useState<AdminPost | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const tpl = useContentTemplate({
    templates: BOARD_TEMPLATES,
    values: { title: notice?.title ?? '', body: notice?.body ?? '' },
    apply: (patch) => setNotice((n) => n && { ...n, ...patch }),
    limits: { title: 100, body: 10_000 },
  });
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: t('saved') });
      await reload();
    } catch (e) {
      setNote(failNote(e, t));
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (p: AdminPost, status: AdminPost['status']) => act(() => api(`/api/admin/board/posts/${p.id}/status`, { body: { status } }));
  async function openNotice(id?: string) {
    setNote(null);
    tpl.reset();
    if (!id) return setNotice({ title: '', body: '' });
    try {
      const p = await api<{ title: string; body: string }>(`/api/admin/board/posts/${id}`);
      setNotice({ id, title: p.title, body: p.body });
    } catch (e) {
      setNote(failNote(e, t));
    }
  }
  const shown = data?.items ?? [];
  const filtered = !!(filter || q);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-extrabold">{t('board')}</h1>
        <Button onClick={() => openNotice()} data-testid="new-notice">{t('newNotice')}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex min-w-0 flex-1 basis-64 gap-2" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); setOffset(0); }}>
          <Input className="min-w-0 flex-1" placeholder={t('boardSearch')} aria-label={t('boardSearch')} value={text} maxLength={100} onChange={(e) => setText(e.target.value)} data-testid="board-q" />
          <Button type="submit" variant="subtle">{t('searchBtn')}</Button>
        </form>
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }} className={selectCls} aria-label={t('status')}>
          <option value="">{t('statusAll')}</option>
          <option value="visible">{t('contentVisible')}</option>
          <option value="hidden">{t('contentHidden')}</option>
          <option value="deleted">{t('contentDeleted')}</option>
        </select>
        {filtered && <Button size="sm" variant="ghost" onClick={() => { setFilter(''); setText(''); setQ(''); setOffset(0); }} data-testid="board-reset">{t('auditReset')}</Button>}
      </div>
      <Feedback note={note} pin />
      {error && <LoadError error={error} onRetry={reload} />}
      <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        <ul className="divide-y divide-white/5">
          {shown.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm" data-testid="board-row">
              {p.isNotice && (
                <Badge tone="gold">
                  <PinIcon className="size-3" />
                  <span className="sr-only">{t('catNotice')}</span>
                </Badge>
              )}
              <span className={`min-w-0 flex-1 truncate ${p.isNotice ? 'font-extrabold text-gold-300' : ''}`}>{p.title}</span>
              <span className="text-xs text-ink-400">{p.author.withdrawn ? `${t('withdrawnAuthor')} (${p.author.id.slice(0, 8)})` : p.author.nickname} · {formatDate(p.createdAt, locale)} · <MessageCircleIcon className="inline size-3 align-[-2px]" /><span className="sr-only">{t('targetComment')} </span>{p.commentCount} · ♠{p.handCount}</span>
              <Badge tone={contentTone(p.status)}>{contentStatusLabel(t, p.status)}</Badge>
              {p.isNotice && <Button size="sm" variant="subtle" onClick={() => openNotice(p.id)}>{t('edit')}</Button>}
              {p.status !== 'visible' ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setStatus(p, 'visible')}>{t('restore')}</Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setStatus(p, 'hidden')}>{t('hide')}</Button>
              )}
              {p.status !== 'deleted' && <Button size="sm" variant="danger" disabled={busy} onClick={() => { setNote(null); setDel(p); }} data-testid="post-delete">{t('delete')}</Button>}
            </li>
          ))}
        </ul>
        {(data || !error) && <ListState loading={!data} empty={shown.length === 0}>{filtered ? t('noMatch') : '—'}</ListState>}
        {data && (shown.length > 0 || offset > 0) && (
          <Pager
            label={t('board')}
            testid="board-pager"
            range={t('auditRangeNoTotal', { from: offset + 1, to: offset + shown.length })}
            prev={offset > 0 ? () => setOffset(Math.max(0, offset - BOARD_PAGE)) : null}
            next={data.more ? () => setOffset(offset + BOARD_PAGE) : null}
            busy={loading}
          />
        )}
      </Panel>
      <Modal
        open={del !== null}
        onClose={() => setDel(null)}
        title={t('delete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDel(null)}>{t('cancel')}</Button>
            <Button variant="danger" loading={busy} onClick={() => del && void setStatus(del, 'deleted').then(() => setDel(null))} data-testid="post-delete-confirm">
              {t('delete')}
            </Button>
          </>
        }
      >
        <p className="break-words text-sm" data-testid="post-delete-text">{del && t('confirmDeletePost', { title: del.title })}</p>
      </Modal>
      <Modal
        open={!!notice}
        onClose={() => setNotice(null)}
        title={notice?.id ? t('edit') : t('newNotice')}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setNotice(null)}>{t('cancel')}</Button>
            <Button
              disabled={!notice || notice.title.trim().length < 2 || !notice.body.trim() || tpl.blocked}
              loading={busy}
              onClick={() =>
                notice &&
                !tpl.blocked &&
                act(async () => {
                  if (notice.id) await api(`/api/admin/board/notices/${notice.id}`, { method: 'PATCH', body: { title: notice.title, body: notice.body } });
                  else await api('/api/admin/board/notices', { body: { title: notice.title, body: notice.body } });
                  setNotice(null);
                })
              }
              data-testid="board-notice-save"
            >
              {t('save')}
            </Button>
          </>
        }
      >
        {notice && (
          <div className="flex flex-col gap-3" data-testid="board-notice-form">
            <ContentTemplateFields tpl={tpl} testid="board-tpl" />
            <Field label={t('titleLabel')}>{(id) => <Input id={id} value={notice.title} maxLength={100} onChange={(e) => setNotice({ ...notice, title: e.target.value })} data-testid="board-notice-title" />}</Field>
            <Field label={t('bodyLabel')}>{(id) => <textarea id={id} rows={8} maxLength={10000} value={notice.body} onChange={(e) => setNotice({ ...notice, body: e.target.value })} className="w-full rounded-lg border border-white/10 bg-ink-850 p-3" data-testid="board-notice-body" />}</Field>
            <TemplatePreview testid="board-preview" items={[{ title: notice.title, body: notice.body }]} />
            <TemplateMissing tpl={tpl} testid="board-missing" />
            <TemplateTooLong tpl={tpl} testid="board-too-long" />
          </div>
        )}
      </Modal>
    </div>
  );
}

interface UserRow { id: string; nickname: string; email: string; status: string; locale: 'ko' | 'en' }
interface Batch { batchId: string; title: string; category: string; createdAt: number; recipients: number; readCount: number; sender: string | null }

export function MessagesAdminPage() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<Note>(null);
  const [picked, setPicked] = useState<UserRow[]>([]);
  const [category, setCategory] = useState<MessageCategory>('notice');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const tpl = useContentTemplate({
    templates: MESSAGE_TEMPLATES[category],
    values: { title, body },
    apply: (patch) => {
      if (patch.title !== undefined) setTitle(patch.title);
      if (patch.body !== undefined) setBody(patch.body);
    },
    limits: { title: 100, body: 2000 },
  });
  const [note, setNote] = useState<Note>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [offset, setOffset] = useState(0);
  const history = useData<OffsetPage<Batch>>(`/api/admin/messages?paged=1&limit=${HISTORY_PAGE}${offset ? `&offset=${offset}` : ''}`);

  async function search(e: FormEvent) {
    e.preventDefault();
    setSearching(true);
    setSearchNote(null);
    try {
      setResults(await api<UserRow[]>(`/api/admin/users?q=${encodeURIComponent(q)}&status=active&limit=50`));
    } catch (e) {
      setSearchNote(failNote(e, t));
    } finally {
      setSearching(false);
    }
  }
  const add = (u: UserRow) => setPicked((p) => (p.some((x) => x.id === u.id) ? p : [...p, u]));
  const en = picked.filter((u) => u.locale === 'en').length;
  const ko = picked.length - en;
  async function send() {
    if (tpl.blocked) return;
    setNote(null);
    setSending(true);
    try {
      const r = await api<{ sent: number }>('/api/admin/messages', { body: { userIds: picked.map((u) => u.id), category, title, body } });
      setNote({ ok: true, text: t('sentTo', { n: r.sent }) });
      setPicked([]);
      setTitle('');
      setBody('');
      tpl.reset();
      setConfirming(false);
      if (offset) setOffset(0);
      else await history.reload();
    } catch (e) {
      setConfirming(false);
      setNote(failNote(e, t));
    } finally {
      setSending(false);
    }
  }
  const batches = history.data?.items ?? [];
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-extrabold">{t('messages')}</h1>
      <p className="text-xs text-ink-400">{t('messagesHint')}</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('recipients')}>
          <form className="mb-3 flex gap-2" onSubmit={search}>
            <Input className="min-w-0 flex-1" placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" variant="subtle" loading={searching}>{t('searchBtn')}</Button>
          </form>
          <Feedback note={searchNote} />
          <ul className="max-h-64 divide-y divide-white/5 overflow-y-auto text-sm">
            {results?.map((u) => (
              <li key={u.id} className="flex items-center gap-2 py-1.5">
                <LangBadge locale={u.locale} />
                <span className="min-w-0 flex-1 truncate">{u.nickname} <span className="text-xs text-ink-400">{u.email}</span></span>
                <Button size="sm" variant="outline" onClick={() => add(u)} disabled={picked.some((x) => x.id === u.id)} aria-label={`${u.nickname} +`}>+</Button>
              </li>
            ))}
          </ul>
          {results && results.length === 0 && <ListState loading={false} empty>{t('noMatch')}</ListState>}
          {results && results.length > 1 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => results.forEach(add)}>{t('addAll')} ({results.length})</Button>}
        </Panel>
        <Panel title={t('compose')}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5" data-testid="picked">
              {picked.length === 0 ? <span className="text-xs text-ink-400">{t('noRecipients')}</span> : picked.map((u) => (
                <button key={u.id} onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))} className="rounded-full border border-gold-500/40 bg-gold-500/10 px-2 py-0.5 text-xs text-gold-300">{u.nickname} <span className="font-mono text-[10px] text-ink-300">{u.locale.toUpperCase()}</span> <XIcon className="inline size-3 align-[-2px]" /></button>
              ))}
            </div>
            {picked.length > 0 && (
              <p className="text-xs text-ink-300" data-testid="recipient-languages">
                {t('recipientLanguages')}: {t('langKo')} {ko} · {t('langEn')} {en}
              </p>
            )}
            <Field label={t('category')}>{(id) => (
              <select id={id} value={category} onChange={(e) => setCategory(e.target.value as MessageCategory)} className="h-11 rounded-lg border border-white/10 bg-ink-850 px-3" data-testid="msg-category">
                <option value="notice">{t('catNotice')}</option>
                <option value="event">{t('catEvent')}</option>
                <option value="admin">{t('catAdmin')}</option>
                <option value="sanction">{t('catSanction')}</option>
              </select>
            )}</Field>
            <ContentTemplateFields tpl={tpl} testid="msg-tpl" />
            <Field label={t('titleLabel')}>{(id) => <Input id={id} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} data-testid="msg-title" />}</Field>
            <Field label={t('bodyLabel')}>{(id) => <textarea id={id} rows={5} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded-lg border border-white/10 bg-ink-850 p-3" data-testid="msg-body" />}</Field>
            <TemplatePreview testid="msg-preview" items={[{ title, body }]} />
            <TemplateMissing tpl={tpl} testid="msg-missing" />
            <TemplateTooLong tpl={tpl} testid="msg-too-long" />
            <Feedback note={note} />
            <Button disabled={picked.length === 0 || !title.trim() || !body.trim() || tpl.blocked} onClick={() => { setNote(null); setConfirming(true); }} data-testid="send-message">{t('send')} ({picked.length})</Button>
          </div>
        </Panel>
      </div>
      <Panel title={t('sentHistory')} className={history.loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        {history.error && <LoadError error={history.error} onRetry={history.reload} />}
        <ul className="divide-y divide-white/5 text-sm">
          {batches.map((b) => (
            <li key={b.batchId} className="flex flex-wrap items-center gap-2 py-2">
              <Badge>{categoryLabel(t, b.category)}</Badge>
              <span className="min-w-0 flex-1 truncate">{b.title}</span>
              <span className="text-xs text-ink-400">{b.sender} · {formatDate(b.createdAt, locale)} · {t('readOfN', { read: b.readCount, n: b.recipients })}</span>
            </li>
          ))}
        </ul>
        {(history.data || !history.error) && <ListState loading={!history.data} empty={batches.length === 0}>—</ListState>}
        {history.data && (batches.length > 0 || offset > 0) && (
          <Pager
            label={t('sentHistory')}
            testid="history-pager"
            range={t('auditRangeNoTotal', { from: offset + 1, to: offset + batches.length })}
            prev={offset > 0 ? () => setOffset(Math.max(0, offset - HISTORY_PAGE)) : null}
            next={history.data.more ? () => setOffset(offset + HISTORY_PAGE) : null}
            busy={history.loading}
          />
        )}
      </Panel>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('send')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>{t('cancel')}</Button>
            <Button loading={sending} onClick={() => void send()} data-testid="send-confirm">{t('send')} ({picked.length})</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm" data-testid="send-summary">
          <p>{t('confirmSend', { n: picked.length, ko, en })}</p>
          <p className="break-words rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2">
            <span className="text-xs text-ink-400">{categoryLabel(t, category)}</span>
            <br />
            <span className="font-semibold">{title.trim()}</span>
          </p>
        </div>
      </Modal>
    </div>
  );
}
