import type { AuthorDto, CommentDto, HandSummaryDto, PostDetailDto, PostListItemDto, PostPageDto, PublicUserDto } from '@jc/types';
import { Badge, Button, Empty, Field, formatDate, inHoleOrder, Input, Modal, Panel, PinIcon, PlayingCard } from '@jc/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { HandReview } from '../components/HandReview';
import { isGone, LoadFailed, Loading } from '../components/Loading';
import { MemberName, RoleBadge, VipBadge, vipOf } from '../components/MemberName';
import { MaintenanceNote } from '../components/MaintenanceNote';
import { PlayerCard, ReportModal, type ReportSubject } from '../components/Social';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useMaintenance, when } from '../lib/service';

type Card = Parameters<typeof PlayingCard>[0]['card'];

/** What went wrong, in words; a refusal for maintenance says that posting is paused and until when. */
function useWhy() {
  const { t, err, locale } = useI18n();
  return (e: unknown) => {
    const endsAt = e instanceof ApiError && e.code === 'maintenance' ? (e.details as { endsAt?: unknown } | undefined)?.endsAt : undefined;
    return typeof endsAt === 'number' ? t('maint.posting', { end: when(endsAt, locale) }) : err(e instanceof ApiError ? e.code : null);
  };
}

/** The author's name; with `onPick` it opens their player card (never for my own posts). */
function AuthorName({ a, onPick }: { a: PostListItemDto['author']; onPick?: (a: AuthorDto) => void }) {
  const { t } = useI18n();
  const { me } = useAuth();
  if (a.withdrawn) return <span className="font-normal italic text-ink-400" data-testid="author-withdrawn">{t('board.withdrawn')}</span>;
  const name = onPick && a.id !== me?.id ? (
    <button type="button" className="min-w-0 font-semibold text-ink-100 hover:text-gold-300 hover:underline" onClick={() => onPick(a)} data-testid="author-name">
      <MemberName name={a.nickname} role={a.role} vip={a.vip} />
    </button>
  ) : (
    <MemberName name={a.nickname} role={a.role} vip={a.vip} />
  );
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {name}
      <RoleBadge role={a.role} />
      {vipOf(a.role, a.vip) && <VipBadge />}
    </span>
  );
}

function PostRow({ p, notice }: { p: PostListItemDto; notice?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <li>
      <Link to={`/board/${p.id}`} className={`flex flex-col gap-1 px-3 py-3 transition hover:bg-white/[0.03] sm:flex-row sm:items-center sm:gap-4 ${notice ? 'bg-gold-500/[0.06]' : ''}`} data-testid={notice ? 'notice-row' : 'post-row'}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {notice && <Badge tone="gold"><PinIcon className="size-3" />{t('board.notice')}</Badge>}
          <span className={`truncate ${notice ? 'font-extrabold text-gold-300' : 'font-medium text-ivory'}`}>{p.title}</span>
          {p.commentCount > 0 && <span className="shrink-0 text-xs font-semibold text-gold-400">[{p.commentCount}]</span>}
          {p.handCount > 0 && <span className="shrink-0 rounded bg-success/15 px-1 text-[10px] font-bold text-[#9fd8b6]">♠ {p.handCount}</span>}
        </span>
        <span className="flex min-w-0 gap-3 text-xs text-ink-400 sm:shrink-0">
          <AuthorName a={p.author} />
          <span className="shrink-0">{formatDate(p.createdAt, locale)}</span>
          <span className="shrink-0">{t('board.views', { n: p.viewCount })}</span>
        </span>
      </Link>
    </li>
  );
}

export function BoardPage() {
  const { t } = useI18n();
  // Members can't post while maintenance is under way (the server refuses it); staff can.
  const paused = useMaintenance().posting;
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const [data, setData] = useState<PostPageDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null);
    setFailed(false);
    api<PostPageDto>(`/api/board/posts?page=${page}&q=${encodeURIComponent(q)}`).then(
      (d) => live && setData(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [page, q, attempt]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('board.title')}</h1>
        <div className="flex gap-2">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setParams(search ? { q: search } : {}); }}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('board.search')} className="sm:w-56" aria-label={t('board.search')} />
          </form>
          {paused ? (
            <Button disabled data-testid="write-post">{t('board.write')}</Button>
          ) : (
            <Link to="/board/write"><Button data-testid="write-post">{t('board.write')}</Button></Link>
          )}
        </div>
      </div>
      {paused && <MaintenanceNote m={paused} what="posting" />}
      <div className="jc-panel overflow-hidden">
        {!data ? (
          failed ? <LoadFailed onRetry={() => setAttempt((n) => n + 1)} /> : <Loading />
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
  const { t, locale } = useI18n();
  const why = useWhy();
  const paused = useMaintenance().posting;
  const nav = useNavigate();
  const [post, setPost] = useState<PostDetailDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [comment, setComment] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PublicUserDto | null>(null);
  const [reporting, setReporting] = useState<ReportSubject | null>(null);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setPost(await api<PostDetailDto>(`/api/board/posts/${id}`));
    } catch (e) {
      // Gone (deleted, never there) reads as not found; a lost connection keeps the post shown, or offers a retry.
      if (isGone(e)) setMissing(true);
      else setFailed(true);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(why(e));
    }
  }
  if (missing) return <Empty>{t('notFound')}</Empty>;
  if (!post) return failed ? <LoadFailed onRetry={() => void load()} /> : <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <Link to="/board" className="text-sm text-gold-300 hover:underline">← {t('board.title')}</Link>
      <article className="jc-panel p-5 sm:p-6">
        <header className="mb-4 border-b border-white/5 pb-4">
          <h1 className={`text-xl sm:text-2xl ${post.isNotice ? 'font-extrabold text-gold-300' : 'font-bold'}`} data-testid="post-title">
            {post.isNotice && <Badge tone="gold" className="mr-2 align-middle"><PinIcon className="size-3" />{t('board.notice')}</Badge>}
            {post.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-400">
            <AuthorName a={post.author} onPick={setPicked} />
            <span>{formatDate(post.createdAt, locale)}{post.updatedAt - post.createdAt > 1000 && ` · ${t('board.edited')}`}</span>
            <span>{t('board.views', { n: post.viewCount })}</span>
            {post.isMine && !post.isNotice && (
              <span className="ml-auto flex gap-2">
                {paused ? (
                  <span className="cursor-not-allowed text-ink-500" aria-disabled="true" data-testid="post-edit">{t('board.edit')}</span>
                ) : (
                  <Link to={`/board/${post.id}/edit`} className="text-gold-300 hover:underline" data-testid="post-edit">{t('board.edit')}</Link>
                )}
                <button className="text-[#f0a0a2] hover:underline" onClick={() => confirm(t('board.deleteConfirm')) && run(async () => { await api(`/api/board/posts/${post.id}`, { method: 'DELETE' }); nav('/board'); })}>{t('board.delete')}</button>
              </span>
            )}
            {!post.isMine && !post.isNotice && post.author.role !== 'super_admin' && (
              <button className="ml-auto text-ink-400 hover:text-[#f0a0a2]" onClick={() => setReporting({ type: 'post', id: post.id, label: post.title })} data-testid="report-post">
                {t('report.action')}
              </button>
            )}
          </div>
        </header>
        {/* Rendered as plain text: no HTML from users is ever interpreted. */}
        <div className="whitespace-pre-wrap break-words leading-relaxed text-ink-100">{post.body}</div>
        {post.hands.length > 0 && <div className="mt-5 flex flex-col gap-3">{post.hands.map((h) => <HandReview key={h.id} hand={h} />)}</div>}
      </article>

      <Panel title={t('board.comments', { n: post.comments.filter((c) => !c.deleted).length })}>
        <ul className="divide-y divide-white/5">
          {post.comments.filter((c) => !c.parentId).map((root) => (
            <li key={root.id} className="py-3">
              <CommentItem c={root} onRun={run} onReply={setReplyTo} replyTo={replyTo} postId={post.id} onPick={setPicked} onReport={setReporting} paused={!!paused} />
              {post.comments.filter((r) => r.parentId === root.id).length > 0 && (
                <ul className="mt-2 flex flex-col gap-2 border-l-2 border-gold-500/20 pl-3 sm:ml-4">
                  {post.comments.filter((r) => r.parentId === root.id).map((r) => (
                    <li key={r.id}><CommentItem c={r} onRun={run} onReply={setReplyTo} replyTo={replyTo} postId={post.id} onPick={setPicked} onReport={setReporting} paused={!!paused} /></li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {paused && <MaintenanceNote m={paused} what="posting" className="mt-3" />}
        <form className="mt-3 flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!comment.trim() || paused) return; void run(async () => { await api(`/api/board/posts/${post.id}/comments`, { body: { body: comment } }); setComment(''); }); }}>
          <Input value={comment} maxLength={1000} disabled={!!paused} onChange={(e) => setComment(e.target.value)} placeholder={t('board.commentPlaceholder')} aria-label={t('board.commentPlaceholder')} data-testid="comment-input" />
          <Button type="submit" disabled={!comment.trim() || !!paused} data-testid="comment-submit">{t('board.addComment')}</Button>
        </form>
        {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      </Panel>
      <PlayerCard user={picked} onClose={() => setPicked(null)} />
      <ReportModal subject={reporting} onClose={() => setReporting(null)} />
    </div>
  );
}

/** One comment or reply with author controls and an inline reply form. */
function CommentItem({ c, onRun, onReply, replyTo, postId, onPick, onReport, paused }: { c: CommentDto; onRun: (fn: () => Promise<unknown>) => Promise<void>; onReply: (id: string | null) => void; replyTo: string | null; postId: string; onPick: (a: AuthorDto) => void; onReport: (s: ReportSubject) => void; paused: boolean }) {
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  if (c.deleted) return <p className="text-sm italic text-ink-400" data-testid="comment">{t('board.deletedComment')}</p>;
  return (
    <div data-testid={c.parentId ? 'reply' : 'comment'}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-400">
        {c.parentId && <span aria-hidden className="text-gold-500/60">↳</span>}
        <span className="font-semibold text-ink-100"><AuthorName a={c.author} onPick={onPick} /></span>
        <span>{formatDate(c.createdAt, locale)}{c.updatedAt - c.createdAt > 1000 && ` · ${t('board.edited')}`}</span>
        <span className="ml-auto flex gap-2">
          <button className="text-ink-300 hover:text-gold-300 disabled:cursor-not-allowed disabled:opacity-40" disabled={paused} onClick={() => onReply(replyTo === c.id ? null : c.id)} data-testid="comment-reply">{t('board.reply')}</button>
          {c.isMine && (
            <>
              <button className="text-gold-300 disabled:cursor-not-allowed disabled:opacity-40" disabled={paused} onClick={() => setEditing(c.body)} data-testid="comment-edit">{t('board.edit')}</button>
              <button className="text-[#f0a0a2]" onClick={() => confirm(t('board.deleteConfirm')) && onRun(() => api(`/api/board/comments/${c.id}`, { method: 'DELETE' }))}>{t('board.delete')}</button>
            </>
          )}
          {!c.isMine && c.author.role !== 'super_admin' && (
            <button className="text-ink-400 hover:text-[#f0a0a2]" onClick={() => onReport({ type: 'comment', id: c.id, label: c.body })} data-testid="report-comment">
              {t('report.action')}
            </button>
          )}
        </span>
      </div>
      {editing !== null ? (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void onRun(async () => { await api(`/api/board/comments/${c.id}`, { method: 'PATCH', body: { body: editing } }); setEditing(null); }); }}>
          <Input value={editing} maxLength={1000} onChange={(e) => setEditing(e.target.value)} />
          <Button type="submit" size="sm" disabled={paused}>{t('common.save')}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
        </form>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-ink-100">
          {c.replyTo && <span className="mr-1 font-semibold text-gold-300">@{c.replyTo}</span>}
          {c.body}
        </p>
      )}
      {replyTo === c.id && (
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!reply.trim()) return; void onRun(async () => { await api(`/api/board/posts/${postId}/comments`, { body: { body: reply, parentId: c.id } }); setReply(''); onReply(null); }); }}>
          <Input autoFocus value={reply} maxLength={1000} onChange={(e) => setReply(e.target.value)} placeholder={t('board.replyPlaceholder', { name: c.author.withdrawn ? t('board.withdrawn') : c.author.nickname })} aria-label={t('board.reply')} />
          <Button type="submit" size="sm" disabled={!reply.trim() || paused} data-testid="reply-submit">{t('board.reply')}</Button>
        </form>
      )}
    </div>
  );
}

export function PostEditorPage() {
  const { id } = useParams();
  const { t, locale } = useI18n();
  const why = useWhy();
  const paused = useMaintenance().posting;
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [handIds, setHandIds] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [myHands, setMyHands] = useState<HandSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // In edit mode the form is shown only after the post is loaded, so typing can never be overwritten.
  const [loaded, setLoaded] = useState(!id);
  const [failed, setFailed] = useState<'post' | 'hands' | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    setFailed(null);
    void api<PostDetailDto>(`/api/board/posts/${id}`).then(
      (p) => {
        setTitle(p.title);
        setBody(p.body);
        setHandIds(p.hands.map((h) => h.id));
        setLoaded(true);
      },
      () => setFailed('post'),
    );
  }, [id, attempt]);
  useEffect(() => {
    if (!picker || myHands) return;
    setFailed(null);
    void api<HandSummaryDto[]>('/api/me/hands?limit=50').then(setMyHands, () => setFailed('hands'));
  }, [picker, myHands, attempt]);

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
      setError(why(x));
    } finally {
      setBusy(false);
    }
  }
  if (!loaded) return failed === 'post' ? <LoadFailed onRetry={() => setAttempt((n) => n + 1)} /> : <Loading />;
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
        {paused && <MaintenanceNote m={paused} what="posting" />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => nav(-1)}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy} disabled={!!paused} data-testid="publish">{t('board.publish')}</Button>
        </div>
      </form>
      <Modal open={picker} onClose={() => setPicker(false)} title={t('board.pickHands')} wide footer={<Button onClick={() => setPicker(false)}>{t('common.confirm')} ({handIds.length}/3)</Button>}>
        {!myHands ? failed === 'hands' ? <LoadFailed className="py-6" onRetry={() => setAttempt((n) => n + 1)} /> : <Loading className="py-6" /> : myHands.length === 0 ? <Empty>{t('board.noHands')}</Empty> : (
          <ul className="flex flex-col gap-1.5">
            {myHands.map((h) => (
              <li key={h.id}>
                <label className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${handIds.includes(h.id) ? 'border-gold-500/60 bg-gold-500/10' : 'border-white/5'}`}>
                  <input type="checkbox" checked={handIds.includes(h.id)} onChange={() => toggle(h.id)} disabled={!handIds.includes(h.id) && handIds.length >= 3} />
                  <span className="flex gap-0.5">{inHoleOrder(h.holeCards).map((c) => <PlayingCard key={c} card={c as Card} size="1.4rem" />)}</span>
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
