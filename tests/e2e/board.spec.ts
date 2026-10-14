import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

test('board: write, comment, edit own content; others cannot edit', async ({ browser }) => {
  const a = await signUp(browser);
  const b = await signUp(browser);
  await a.page.goto('/board');
  await a.page.getByTestId('write-post').click();
  await a.page.getByLabel(/제목|Title/).fill('E2E 첫 게시글');
  await a.page.getByLabel(/내용|Text/).fill('<b>태그는 그대로 글자로 보여야 합니다</b>');
  await a.page.getByTestId('publish').click();
  await expect(a.page.getByTestId('post-title')).toHaveText('E2E 첫 게시글');
  await expect(a.page.getByText('<b>태그는 그대로 글자로 보여야 합니다</b>')).toBeVisible();
  const url = a.page.url();

  await b.page.goto(url);
  await expect(b.page.getByRole('link', { name: /^수정$|^Edit$/ })).toHaveCount(0);
  await b.page.getByPlaceholder(/댓글|comment/i).fill('B의 댓글');
  await b.page.getByRole('button', { name: /댓글 등록|^Comment$/ }).click();
  await expect(b.page.getByTestId('comment')).toContainText('B의 댓글');

  // A replies to B's comment (threaded under it).
  await a.page.reload();
  await a.page.getByTestId('comment').getByRole('button', { name: /^답글$|^Reply$/ }).click();
  await a.page.getByLabel(/^답글$|^Reply$/).fill('A의 답글');
  await a.page.getByTestId('reply-submit').click();
  await expect(a.page.getByTestId('reply')).toContainText('A의 답글');
  await b.page.reload();
  await expect(b.page.getByTestId('reply')).toContainText('A의 답글');

  // A edits the post; B's comment shows no edit control for A.
  await a.page.reload();
  await expect(a.page.getByTestId('comment').getByRole('button', { name: /수정|Edit/ })).toHaveCount(0);
  await a.page.getByRole('link', { name: /^수정$|^Edit$/ }).click();
  await a.page.getByLabel(/제목|Title/).fill('E2E 수정된 제목');
  await a.page.getByTestId('publish').click();
  await expect(a.page.getByTestId('post-title')).toHaveText('E2E 수정된 제목');

  // My page lists the post for A and the comment for B.
  await a.page.goto('/me');
  await expect(a.page.getByTestId('my-posts')).toContainText('E2E 수정된 제목');
  await b.page.goto('/me');
  await expect(b.page.getByTestId('my-comments')).toContainText('B의 댓글');
});
