import type { HandSummaryDto, PostDetailDto, PostListItemDto, PostPageDto } from '@jc/types';
import { Badge, Button, Empty, Field, formatDate, Input, Modal, Panel, PlayingCard, Spinner } from '@jc/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { HandReview } from '../components/HandReview';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';

type Card = Parameters<typeof PlayingCard>[0]['card'];

function AuthorName({ a }: { a: PostListItemDto['author'] }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1">
      {a.nickname}
      {a.isAdmin && <Badge tone="gold">{t('board.admin')}</Badge>}
    </span>
  );
}

function PostRow({ p, notice }: { p: PostListItemDto; notice?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <li>
      <Link to={`/board/${p.id}`} className={`flex flex-col gap-1 px-3 py-3 transition hover:bg-white/[0.03] sm:flex-row sm:items-center sm:gap-4 ${notice ? 'bg-gold-500/[0.06]' : ''}`} data-testid={notice ? 'notice-row' : 'post-row'}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {notice && <Badge tone="gold">📌 {t('board.notice')}</Badge>}
          <span className={`truncate ${notice ? 'font-extrabold text-gold-300' : 'font-medium text-ivory'}`}>{p.title}</span>
          {p.commentCount > 0 && <span className="shrink-0 text-xs font-semibold text-gold-400">[{p.commentCount}]</span>}
          {p.handCount > 0 && <span className="shrink-0 rounded bg-success/15 px-1 text-[10px] font-bold text-[#9fd8b6]">♠ {p.handCount}</span>}
        </span>
        <span className="flex shrink-0 gap-3 text-xs text-ink-400">
          <AuthorName a={p.author} />
          <span>{formatDate(p.createdAt, locale)}</span>
          <span>{t('board.views', { n: p.viewCount })}</span>
        </span>
      </Link>
    </li>
  );
}

export function BoardPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const [data, setData] = useState<PostPageDto | null>(null);
  useEffect(() => {
    setData(null);
    void api<PostPageDto>(`/api/board/posts?page=${page}&q=${encodeURIComponent(q)}`).then(setData);
  }, [page, q]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('board.title')}</h1>
        <div className="flex gap-2">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setParams(search ? { q: search } : {}); }}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('board.search')} className="sm:w-56" aria-label={t('board.search')} />
          </form>
          <Link to="/board/write"><Button data-testid="write-post">{t('board.write')}</Button></Link>
        </div>
      </div>
      <div className="jc-panel overflow-hidden">
        {!data ? (
          <div className="flex justify-center py-12 text-gold-400"><Spinner /></div>
        ) : (
          <ul className="divide-y divide-white/5">
            {data.notices.map((p) => <PostRow key={p.id} p={p} notice />)}
            {data.posts.map((p) => <PostRow key={p.id} p={p} />)}
            {data.notices.length + data.posts.length === 0 && <li className="p-6"><Empty>{t('board.empty')}</Empty></li>}
          </ul>
        )}
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button size="sm" variant="subtle" disabled={page <= 1} onClick={() => setParams({ ...(q ? { q } : {}), page: String(page - 1) })}>{t('board.prev')}</Button>
          <span className="font-mono text-ink-300">{page} / {pages}</span>
          <Button size="sm" variant="subtle" disabled={page >= pages} onClick={() => setParams({ ...(q ? { q } : {}), page: String(page + 1) })}>{t('board.next')}</Button>
        </div>
      )}
    </div>
  );
}

export function PostPage() {
  const { id = '' } = useParams();
  const { t, locale, err } = useI18n();
  const nav = useNavigate();
  const [post, setPost] = useState<PostDetailDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setPost(await api<PostDetailDto>(`/api/board/posts/${id}`));
    } catch {
      setMissing(true);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(err(e instanceof ApiError ? e.code : null));
    }
  }
  if (missing) return <Empty>{t('notFound')}</Empty>;
  if (!post) return <div className="flex justify-center py-12 text-gold-400"><Spinner /></div>;
  return (
    <div className="flex flex-col gap-5">
      <Link to="/board" className="text-sm text-gold-300 hover:underline">← {t('board.title')}</Link>
      <article className="jc-panel p-5 sm:p-6">
        <header className="mb-4 border-b border-white/5 pb-4">
          <h1 className={`text-xl sm:text-2xl ${post.isNotice ? 'font-extrabold text-gold-300' : 'font-bold'}`} data-testid="post-title">
            {post.isNotice && <Badge tone="gold" className="mr-2 align-middle">📌 {t('board.notice')}</Badge>}
            {post.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-400">
            <AuthorName a={post.author} />
            <span>{formatDate(post.createdAt, locale)}{post.updatedAt - post.createdAt > 1000 && ` · ${t('board.edited')}`}</span>
            <span>{t('board.views', { n: post.viewCount })}</span>
            {post.isMine && !post.isNotice && (
              <span className="ml-auto flex gap-2">
                <Link to={`/board/${post.id}/edit`} className="text-gold-300 hover:underline">{t('board.edit')}</Link>
                <button className="text-[#f0a0a2] hover:underline" onClick={() => confirm(t('board.deleteConfirm')) && run(async () => { await api(`/api/board/posts/${post.id}`, { method: 'DELETE' }); nav('/board'); })}>{t('board.delete')}</button>
              </span>
            )}
          </div>
        </header>
        {/* Rendered as plain text: no HTML from users is ever interpreted. */}
        <div className="whitespace-pre-wrap break-words leading-relaxed text-ink-100">{post.body}</div>
        {post.hands.length > 0 && <div className="mt-5 flex flex-col gap-3">{post.hands.map((h) => <HandReview key={h.id} hand={h} />)}</div>}
      </article>

      <Panel title={t('board.comments', { n: post.comments.length })}>
        <ul className="divide-y divide-white/5">
          {post.comments.map((c) => (
            <li key={c.id} className="py-3" data-testid="comment">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                <span className="font-semibold text-ink-100"><AuthorName a={c.author} /></span>
                <span>{formatDate(c.createdAt, locale)}{c.updatedAt - c.createdAt > 1000 && ` · ${t('board.edited')}`}</span>
                {c.isMine && (
                  <span className="ml-auto flex gap-2">
                    <button className="text-gold-300" onClick={() => setEditing({ id: c.id, body: c.body })}>{t('board.edit')}</button>
                    <button className="text-[#f0a0a2]" onClick={() => confirm(t('board.deleteConfirm')) && run(() => api(`/api/board/comments/${c.id}`, { method: 'DELETE' }))}>{t('board.delete')}</button>
                  </span>
                )}
              </div>
              {editing?.id === c.id ? (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/api/board/comments/${c.id}`, { method: 'PATCH', body: { body: editing.body } }); setEditing(null); }); }}>
                  <Input value={editing.body} maxLength={1000} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} />
                  <Button type="submit" size="sm">{t('common.save')}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                </form>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm text-ink-100">{c.body}</p>
              )}
            </li>
          ))}
        </ul>
        <form className="mt-3 flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!comment.trim()) return; void run(async () => { await api(`/api/board/posts/${post.id}/comments`, { body: { body: comment } }); setComment(''); }); }}>
          <Input value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} placeholder={t('board.commentPlaceholder')} aria-label={t('board.commentPlaceholder')} />
          <Button type="submit" disabled={!comment.trim()}>{t('board.addComment')}</Button>
        </form>
        {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      </Panel>
    </div>
  );
}

export function PostEditorPage() {
  const { id } = useParams();
  const { t, locale, err } = useI18n();
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [handIds, setHandIds] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [myHands, setMyHands] = useState<HandSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    void api<PostDetailDto>(`/api/board/posts/${id}`).then((p) => {
      setTitle(p.title);
      setBody(p.body);
      setHandIds(p.hands.map((h) => h.id));
    });
  }, [id]);
  useEffect(() => {
    if (picker && !myHands) void api<HandSummaryDto[]>('/api/me/hands?limit=50').then(setMyHands);
  }, [picker, myHands]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (id) {
        await api(`/api/board/posts/${id}`, { method: 'PATCH', body: { title, body, handIds } });
        nav(`/board/${id}`);
      } else {
        const r = await api<{ id: string }>('/api/board/posts', { body: { title, body, handIds } });
        nav(`/board/${r.id}`);
      }
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (hid: string) => setHandIds((cur) => (cur.includes(hid) ? cur.filter((x) => x !== hid) : cur.length >= 3 ? cur : [...cur, hid]));
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <h1 className="text-xl font-extrabold">{id ? t('board.edit') : t('board.write')}</h1>
      <form className="jc-panel flex flex-col gap-4 p-5" onSubmit={submit}>
        <Field label={t('board.postTitle')}>{(fid) => <Input id={fid} required minLength={2} maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('board.postBody')}>
          {(fid) => <textarea id={fid} required maxLength={10000} rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded-lg border border-white/10 bg-ink-850 p-3 text-ivory focus:border-gold-500/70 focus:outline-none" />}
        </Field>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-300">{t('board.attachHands')}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => setPicker(true)} data-testid="pick-hands">{t('board.pickHands')} ({handIds.length}/3)</Button>
          </div>
          <p className="text-xs text-ink-400">{t('board.attachHint')}</p>
        </div>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => nav(-1)}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy} data-testid="publish">{t('board.publish')}</Button>
        </div>
      </form>
      <Modal open={picker} onClose={() => setPicker(false)} title={t('board.pickHands')} wide footer={<Button onClick={() => setPicker(false)}>{t('common.confirm')} ({handIds.length}/3)</Button>}>
        {!myHands ? <div className="flex justify-center py-6 text-gold-400"><Spinner /></div> : myHands.length === 0 ? <Empty>{t('board.noHands')}</Empty> : (
          <ul className="flex flex-col gap-1.5">
            {myHands.map((h) => (
              <li key={h.id}>
                <label className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${handIds.includes(h.id) ? 'border-gold-500/60 bg-gold-500/10' : 'border-white/5'}`}>
                  <input type="checkbox" checked={handIds.includes(h.id)} onChange={() => toggle(h.id)} disabled={!handIds.includes(h.id) && handIds.length >= 3} />
                  <span className="flex gap-0.5">{h.holeCards.map((c) => <PlayingCard key={c} card={c as Card} size="1.4rem" />)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{h.tableName} #{h.handNumber}</span>
                  <span className="text-xs text-ink-400">{formatDate(h.endedAt, locale)}</span>
                  <span className={`font-mono text-xs ${h.net >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}`}>{h.net > 0 ? '+' : ''}{h.net}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
