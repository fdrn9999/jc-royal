import { beforeAll, describe, expect, it } from 'vitest';
import { Client, newUser, PASSWORD, sharedAdmin, uniq } from '../support/client';
import { isMyTurn, TableSocket } from '../support/ws';

const ADMIN_ORIGIN = 'http://localhost:5174';
let admin: Client;

beforeAll(async () => {
  admin = sharedAdmin();
  expect((await admin.get('/api/admin/auth/me')).status).toBe(200);
});

/** Re-confirms the password unless the 5-minute window is still open (re-confirmation is rate limited per account). */
async function reauth() {
  const until = (await admin.get('/api/admin/auth/me')).body?.reauthValidUntil;
  if (until && until - Date.now() > 60_000) return;
  expect((await admin.post('/api/admin/auth/reauth', { password: PASSWORD })).status).toBe(200);
}

describe('messages (one-way, admin → user)', () => {
  it('a welcome message arrives on signup; read and delete work; users cannot send', async () => {
    const u = await newUser();
    expect((await u.client.get('/api/messages/unread-count')).body.unread).toBe(1);
    const list = (await u.client.get('/api/messages')).body;
    expect(list[0]).toMatchObject({ category: 'system', fromAdmin: null, readAt: null });
    expect((await u.client.post(`/api/messages/${list[0].id}/read`, {})).status).toBe(200);
    expect((await u.client.get('/api/messages/unread-count')).body.unread).toBe(0);
    expect((await u.client.req('DELETE', `/api/messages/${list[0].id}`)).status).toBe(200);
    expect((await u.client.get('/api/messages')).body).toHaveLength(0);
    // there is no endpoint for users to send messages
    expect((await u.client.post('/api/messages', { userIds: [u.me.id], title: 'x', body: 'y' })).status).toBe(404);
    // another user's message id is not accessible
    const other = await newUser();
    const theirs = (await other.client.get('/api/messages')).body[0];
    expect((await u.client.post(`/api/messages/${theirs.id}/read`, {})).status).toBe(404);
  });

  it('admin sends to several users at once; sanctions and chip events notify automatically', async () => {
    const a = await newUser();
    const b = await newUser();
    const sent = await admin.post('/api/admin/messages', { userIds: [a.me.id, b.me.id], category: 'event', title: '주말 이벤트', body: '토요일 토너먼트에 참여하세요' });
    expect(sent.status).toBe(201);
    expect(sent.body.sent).toBe(2);
    for (const u of [a, b]) expect((await u.client.get('/api/messages')).body[0]).toMatchObject({ category: 'event', title: '주말 이벤트', fromAdmin: 'superadmin' });
    expect((await admin.post('/api/admin/messages', { userIds: [a.me.id, 'no-such-user'], category: 'admin', title: 't', body: 'b' })).status).toBe(400);
    const history = (await admin.get('/api/admin/messages')).body as { batchId: string; recipients: number }[];
    expect(history.find((h) => h.batchId === sent.body.batchId)?.recipients).toBe(2);

    await reauth();
    await admin.post(`/api/admin/users/${a.me.id}/chips`, { amount: 1000, memo: '출석 이벤트', idempotencyKey: uniq('ev') });
    expect((await a.client.get('/api/messages')).body[0]).toMatchObject({ category: 'event', title: '가상 칩 지급 안내' });

    await admin.post(`/api/admin/users/${b.me.id}/suspend`, { reason: '욕설' });
    await admin.post(`/api/admin/users/${b.me.id}/unsuspend`, { reason: 'appeal accepted' });
    const relog = new Client();
    expect((await relog.post('/api/auth/login', { email: b.email, password: PASSWORD })).status).toBe(200);
    const inbox = (await relog.get('/api/messages')).body as { category: string; title: string; body: string }[];
    expect(inbox.filter((m) => m.category === 'sanction').map((m) => m.title)).toEqual(['계정 이용 제한 해제 안내', '계정 이용 제한 안내']);
    expect(inbox.find((m) => m.title === '계정 이용 제한 안내')!.body).toContain('욕설');
  });
});

describe('board', () => {
  it('members post, edit and delete their own posts and comments only; my page lists them', async () => {
    const a = await newUser();
    const b = await newUser();
    const created = await a.client.post('/api/board/posts', { title: '첫 글입니다', body: '안녕하세요 <script>alert(1)</script>' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const page = (await b.client.get('/api/board/posts')).body;
    expect(page.posts.find((p: { id: string }) => p.id === id)).toMatchObject({ title: '첫 글입니다', isNotice: false });
    const detail = (await b.client.get(`/api/board/posts/${id}`)).body;
    expect(detail).toMatchObject({ isMine: false, body: '안녕하세요 <script>alert(1)</script>' });
    // only the author may edit / delete
    expect((await b.client.patch(`/api/board/posts/${id}`, { title: '탈취', body: 'x' })).status).toBe(403);
    expect((await b.client.req('DELETE', `/api/board/posts/${id}`)).status).toBe(403);
    expect((await a.client.patch(`/api/board/posts/${id}`, { title: '수정된 글', body: '본문 수정' })).status).toBe(200);
    // comments
    const cm = await b.client.post(`/api/board/posts/${id}/comments`, { body: '좋은 글이네요' });
    expect(cm.status).toBe(201);
    expect((await a.client.patch(`/api/board/comments/${cm.body.id}`, { body: '남의 댓글 수정' })).status).toBe(403);
    expect((await b.client.patch(`/api/board/comments/${cm.body.id}`, { body: '수정한 댓글' })).status).toBe(200);
    const after = (await a.client.get(`/api/board/posts/${id}`)).body;
    expect(after).toMatchObject({ title: '수정된 글', commentCount: 1, isMine: true });
    expect(after.comments[0]).toMatchObject({ body: '수정한 댓글', isMine: false });
    // my page
    expect((await a.client.get('/api/me/posts')).body.map((p: { id: string }) => p.id)).toContain(id);
    expect((await b.client.get('/api/me/comments')).body[0]).toMatchObject({ postId: id, postTitle: '수정된 글', body: '수정한 댓글' });
    // delete comment then post
    expect((await b.client.req('DELETE', `/api/board/comments/${cm.body.id}`)).status).toBe(200);
    expect((await a.client.get(`/api/board/posts/${id}`)).body.commentCount).toBe(0);
    expect((await a.client.req('DELETE', `/api/board/posts/${id}`)).status).toBe(200);
    expect((await b.client.get(`/api/board/posts/${id}`)).status).toBe(404);
    // validation
    expect((await a.client.post('/api/board/posts', { title: 'x', body: '' })).status).toBe(400);
  });

  it('replies form two-level threads; deleted parents with replies remain as placeholders', async () => {
    const a = await newUser();
    const b = await newUser();
    const c3 = await newUser();
    const post = (await a.client.post('/api/board/posts', { title: '답글 테스트', body: '본문' })).body.id;
    const root = (await b.client.post(`/api/board/posts/${post}/comments`, { body: '루트 댓글' })).body.id;
    const r1 = (await a.client.post(`/api/board/posts/${post}/comments`, { body: '첫 답글', parentId: root })).body.id;
    // replying to a reply stays in the same thread and mentions the reply's author
    const r2 = await c3.client.post(`/api/board/posts/${post}/comments`, { body: '답글의 답글', parentId: r1 });
    expect(r2.status).toBe(201);
    let d = (await a.client.get(`/api/board/posts/${post}`)).body;
    const byId = Object.fromEntries(d.comments.map((x: { id: string }) => [x.id, x]));
    expect(byId[r1]).toMatchObject({ parentId: root, replyTo: null });
    expect(byId[r2.body.id]).toMatchObject({ parentId: root, replyTo: a.me.nickname });
    expect(d.commentCount).toBe(3);
    // reply to a comment of another post is rejected
    const other = (await a.client.post('/api/board/posts', { title: '다른 글', body: '본문' })).body.id;
    expect((await a.client.post(`/api/board/posts/${other}/comments`, { body: 'x', parentId: root })).status).toBe(404);
    // deleting the root keeps a placeholder while replies exist
    expect((await b.client.req('DELETE', `/api/board/comments/${root}`)).status).toBe(200);
    d = (await c3.client.get(`/api/board/posts/${post}`)).body;
    const placeholder = d.comments.find((x: { id: string }) => x.id === root);
    expect(placeholder).toMatchObject({ deleted: true, body: '', isMine: false });
    expect(d.comments.filter((x: { deleted: boolean }) => !x.deleted)).toHaveLength(2);
    expect(d.commentCount).toBe(2);
    // no new replies to a deleted comment
    expect((await c3.client.post(`/api/board/posts/${post}/comments`, { body: 'late', parentId: root })).status).toBe(404);
    // when the last replies go, the placeholder disappears
    await a.client.req('DELETE', `/api/board/comments/${r1}`);
    await c3.client.req('DELETE', `/api/board/comments/${r2.body.id}`);
    expect((await a.client.get(`/api/board/posts/${post}`)).body.comments).toEqual([]);
  });

  it('notices are admin-only and pinned above posts; members cannot edit them', async () => {
    const n = await admin.post('/api/admin/board/notices', { title: '[공지] 서비스 점검 안내', body: '10월 20일 02:00~04:00 점검' });
    expect(n.status).toBe(201);
    const u = await newUser();
    await u.client.post('/api/board/posts', { title: '일반 글', body: '본문' });
    const page = (await u.client.get('/api/board/posts')).body;
    expect(page.notices.map((p: { id: string }) => p.id)).toContain(n.body.id);
    expect(page.notices[0]).toMatchObject({ isNotice: true });
    expect(page.posts.some((p: { id: string }) => p.id === n.body.id)).toBe(false);
    expect((await u.client.patch(`/api/board/posts/${n.body.id}`, { title: 'hack', body: 'hack' })).status).toBe(403);
    expect((await u.client.get('/api/board/posts?page=2')).body.notices).toEqual([]);
  });

  it('admins can hide posts and comments (moderation is audited)', async () => {
    const u = await newUser();
    const p = (await u.client.post('/api/board/posts', { title: '문제 글', body: '...' })).body.id;
    const c = (await u.client.post(`/api/board/posts/${p}/comments`, { body: '문제 댓글' })).body.id;
    expect((await admin.post(`/api/admin/board/comments/${c}/status`, { status: 'hidden' })).status).toBe(200);
    expect((await u.client.get(`/api/board/posts/${p}`)).body.comments).toHaveLength(0);
    expect((await admin.post(`/api/admin/board/posts/${p}/status`, { status: 'hidden' })).status).toBe(200);
    expect((await u.client.get(`/api/board/posts/${p}`)).status).toBe(404);
    const audit = (await admin.get('/api/admin/audit')).body as { action: string }[];
    expect(audit.some((a) => a.action === 'board.post.status')).toBe(true);
  });

  it('hand review: attach own finished hands; other players’ hidden cards stay hidden', async () => {
    const a = await newUser();
    const b = await newUser();
    const wa = await TableSocket.open(a.client, 'it-board-0');
    const wb = await TableSocket.open(b.client, 'it-board-0');
    expect(await wa.request({ t: 'sit', seatIndex: 0, buyIn: 500 })).toMatchObject({ t: 'ack' });
    expect(await wb.request({ t: 'sit', seatIndex: 1, buyIn: 500 })).toMatchObject({ t: 'ack' });
    await wa.waitState((s) => s.status === 'playing', 15_000);
    await wb.waitState((s) => s.status === 'playing');
    const actor = isMyTurn(wa.state!) ? wa : wb;
    await actor.act('fold'); // no showdown: the opponent's cards must stay private
    await wa.waitState((s) => s.hand?.stage === 'settled' || (s.hand?.number ?? 0) > 1, 15_000);
    await new Promise((r) => setTimeout(r, 500));
    const hand = (await a.client.get('/api/me/hands')).body[0];
    expect(hand).toBeTruthy();
    // b cannot attach a hand it did not play; a can
    const outsider = await newUser();
    expect((await outsider.client.post('/api/board/posts', { title: '남의 핸드', body: 'x', handIds: [hand.id] })).status).toBe(400);
    const post = await a.client.post('/api/board/posts', { title: '핸드 리뷰 부탁', body: '이 폴드 맞나요?', handIds: [hand.id] });
    expect(post.status).toBe(201);
    const view = (await outsider.client.get(`/api/board/posts/${post.body.id}`)).body;
    expect(view.handCount).toBe(1);
    const review = view.hands[0];
    expect(review.players).toHaveLength(2);
    const authorRow = review.players.find((p: { isAuthor: boolean }) => p.isAuthor);
    const otherRow = review.players.find((p: { isAuthor: boolean }) => !p.isAuthor);
    expect(authorRow.holeCards).toHaveLength(2);
    expect(otherRow.holeCards).toBeNull();
    expect(review.actions.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['post-sb', 'post-bb', 'fold']));
    expect(JSON.stringify(view)).not.toMatch(/remainingDeck|engine/);
    wa.close();
    wb.close();
  });
});
