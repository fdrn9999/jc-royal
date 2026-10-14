import { Badge, Button, Empty, Field, formatDate, Input, Modal, Panel } from '@jc/ui';
import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
import { ApiError, useAdmin, useData } from '../lib';

const errMsg = (e: unknown) => (e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));

interface AdminPost {
  id: string;
  title: string;
  isNotice: boolean;
  status: 'visible' | 'hidden' | 'deleted';
  author: { nickname: string; isAdmin: boolean };
  commentCount: number;
  viewCount: number;
  handCount: number;
  createdAt: number;
}

export function BoardAdminPage() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [filter, setFilter] = useState('');
  const { data, reload } = useData<AdminPost[]>(`/api/admin/board/posts${filter ? `?status=${filter}` : ''}`);
  const [notice, setNotice] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMsg(t('saved'));
      await reload();
    } catch (e) {
      setMsg(errMsg(e));
    }
  };
  async function openNotice(id?: string) {
    if (!id) return setNotice({ title: '', body: '' });
    const p = await api<{ title: string; body: string }>(`/api/admin/board/posts/${id}`);
    setNotice({ id, title: p.title, body: p.body });
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-extrabold">{t('board')}</h1>
        <div className="flex gap-2">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="h-10 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm" aria-label={t('status')}>
            <option value="">all</option>
            <option value="visible">visible</option>
            <option value="hidden">hidden</option>
            <option value="deleted">deleted</option>
          </select>
          <Button onClick={() => openNotice()} data-testid="new-notice">{t('newNotice')}</Button>
        </div>
      </div>
      {msg && <p className="text-sm text-gold-300" role="status">{msg}</p>}
      <Panel>
        {data && data.length === 0 ? <Empty>—</Empty> : (
          <ul className="divide-y divide-white/5">
            {data?.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                {p.isNotice && <Badge tone="gold">📌</Badge>}
                <span className={`min-w-0 flex-1 truncate ${p.isNotice ? 'font-extrabold text-gold-300' : ''}`}>{p.title}</span>
                <span className="text-xs text-ink-400">{p.author.nickname} · {formatDate(p.createdAt, locale)} · 💬{p.commentCount} · ♠{p.handCount}</span>
                <Badge tone={p.status === 'visible' ? 'green' : 'red'}>{p.status}</Badge>
                {p.isNotice && <Button size="sm" variant="subtle" onClick={() => openNotice(p.id)}>{t('edit')}</Button>}
                {p.status !== 'visible' ? (
                  <Button size="sm" variant="outline" onClick={() => act(() => api(`/api/admin/board/posts/${p.id}/status`, { body: { status: 'visible' } }))}>{t('restore')}</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => act(() => api(`/api/admin/board/posts/${p.id}/status`, { body: { status: 'hidden' } }))}>{t('hide')}</Button>
                )}
                {p.status !== 'deleted' && <Button size="sm" variant="danger" onClick={() => act(() => api(`/api/admin/board/posts/${p.id}/status`, { body: { status: 'deleted' } }))}>{t('delete')}</Button>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Modal
        open={!!notice}
        onClose={() => setNotice(null)}
        title={notice?.id ? t('edit') : t('newNotice')}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setNotice(null)}>{t('cancel')}</Button>
            <Button
              disabled={!notice || notice.title.trim().length < 2 || !notice.body.trim()}
              onClick={() =>
                notice &&
                act(async () => {
                  if (notice.id) await api(`/api/admin/board/notices/${notice.id}`, { method: 'PATCH', body: { title: notice.title, body: notice.body } });
                  else await api('/api/admin/board/notices', { body: { title: notice.title, body: notice.body } });
                  setNotice(null);
                })
              }
            >
              {t('save')}
            </Button>
          </>
        }
      >
        {notice && (
          <div className="flex flex-col gap-3">
            <Field label={t('titleLabel')}>{(id) => <Input id={id} value={notice.title} maxLength={100} onChange={(e) => setNotice({ ...notice, title: e.target.value })} />}</Field>
            <Field label={t('bodyLabel')}>{(id) => <textarea id={id} rows={8} maxLength={10000} value={notice.body} onChange={(e) => setNotice({ ...notice, body: e.target.value })} className="w-full rounded-lg border border-white/10 bg-ink-850 p-3" />}</Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface UserRow { id: string; nickname: string; email: string; status: string }
interface Batch { batchId: string; title: string; category: string; createdAt: number; recipients: number; readCount: number; sender: string | null }

export function MessagesAdminPage() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserRow[]>([]);
  const [picked, setPicked] = useState<UserRow[]>([]);
  const [category, setCategory] = useState<'event' | 'notice' | 'admin' | 'sanction'>('notice');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const history = useData<Batch[]>('/api/admin/messages');

  async function search(e: FormEvent) {
    e.preventDefault();
    setResults(await api<UserRow[]>(`/api/admin/users?q=${encodeURIComponent(q)}&status=active&limit=50`));
  }
  const add = (u: UserRow) => setPicked((p) => (p.some((x) => x.id === u.id) ? p : [...p, u]));
  async function send() {
    setMsg(null);
    try {
      const r = await api<{ sent: number }>('/api/admin/messages', { body: { userIds: picked.map((u) => u.id), category, title, body } });
      setMsg(t('sentTo', { n: r.sent }));
      setPicked([]);
      setTitle('');
      setBody('');
      await history.reload();
    } catch (e) {
      setMsg(errMsg(e));
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-extrabold">{t('messages')}</h1>
      <p className="text-xs text-ink-400">{t('messagesHint')}</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('recipients')}>
          <form className="mb-3 flex gap-2" onSubmit={search}>
            <Input placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" variant="subtle">⌕</Button>
          </form>
          <ul className="max-h-64 divide-y divide-white/5 overflow-y-auto text-sm">
            {results.map((u) => (
              <li key={u.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">{u.nickname} <span className="text-xs text-ink-400">{u.email}</span></span>
                <Button size="sm" variant="outline" onClick={() => add(u)} disabled={picked.some((x) => x.id === u.id)}>+</Button>
              </li>
            ))}
          </ul>
          {results.length > 1 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => results.forEach(add)}>{t('addAll')} ({results.length})</Button>}
        </Panel>
        <Panel title={t('compose')}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5" data-testid="picked">
              {picked.length === 0 ? <span className="text-xs text-ink-400">{t('noRecipients')}</span> : picked.map((u) => (
                <button key={u.id} onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))} className="rounded-full border border-gold-500/40 bg-gold-500/10 px-2 py-0.5 text-xs text-gold-300">{u.nickname} ✕</button>
              ))}
            </div>
            <Field label={t('category')}>{(id) => (
              <select id={id} value={category} onChange={(e) => setCategory(e.target.value as typeof category)} className="h-11 rounded-lg border border-white/10 bg-ink-850 px-3">
                <option value="notice">notice</option>
                <option value="event">event</option>
                <option value="admin">admin</option>
                <option value="sanction">sanction</option>
              </select>
            )}</Field>
            <Field label={t('titleLabel')}>{(id) => <Input id={id} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <Field label={t('bodyLabel')}>{(id) => <textarea id={id} rows={5} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded-lg border border-white/10 bg-ink-850 p-3" />}</Field>
            {msg && <p className="text-sm text-gold-300" role="status">{msg}</p>}
            <Button disabled={picked.length === 0 || !title.trim() || !body.trim()} onClick={send} data-testid="send-message">{t('send')} ({picked.length})</Button>
          </div>
        </Panel>
      </div>
      <Panel title={t('sentHistory')}>
        {history.data && history.data.length === 0 ? <Empty>—</Empty> : (
          <ul className="divide-y divide-white/5 text-sm">
            {history.data?.map((b) => (
              <li key={b.batchId} className="flex flex-wrap items-center gap-2 py-2">
                <Badge>{b.category}</Badge>
                <span className="min-w-0 flex-1 truncate">{b.title}</span>
                <span className="text-xs text-ink-400">{b.sender} · {formatDate(b.createdAt, locale)} · {b.readCount}/{b.recipients} read</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
