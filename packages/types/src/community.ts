import { z } from 'zod';

export const PostInputSchema = z.object({
  title: z.string().trim().min(2).max(100),
  body: z.string().trim().min(1).max(10_000),
  /** Finished hands the author played, attached for hand review. */
  handIds: z.array(z.string().min(1).max(128)).max(3).default([]),
});
export type PostInput = z.infer<typeof PostInputSchema>;

export const CommentInputSchema = z.object({ body: z.string().trim().min(1).max(1_000) });
export const CommentCreateSchema = CommentInputSchema.extend({ parentId: z.string().min(1).max(64).optional() });

export const MESSAGE_CATEGORIES = ['system', 'event', 'sanction', 'notice', 'admin'] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export const MessageSendSchema = z.object({
  userIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  category: z.enum(['event', 'notice', 'admin', 'sanction']),
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(2_000),
});

export interface AuthorDto {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** The author deleted their account: the post stays, shown as "withdrawn member" with no nickname or avatar. */
  withdrawn?: true;
}

export interface PostListItemDto {
  id: string;
  title: string;
  isNotice: boolean;
  author: AuthorDto;
  commentCount: number;
  viewCount: number;
  handCount: number;
  createdAt: number;
  updatedAt: number;
}

/** A finished hand as shown in a hand review: board, actions and only the cards the author may show. */
export interface HandReviewDto {
  id: string;
  tableName: string;
  handNumber: number;
  endedAt: number;
  board: string[];
  potTotal: number;
  smallBlind: number | null;
  bigBlind: number | null;
  players: {
    seatIndex: number;
    nickname: string;
    isAuthor: boolean;
    holeCards: string[] | null;
    stackStart: number;
    net: number;
    won: number;
    rankClass: string | null;
  }[];
  actions: { seatIndex: number; stage: string; type: string; amount: number }[];
}

export interface CommentDto {
  id: string;
  /** null for top-level comments; replies reference their top-level comment. */
  parentId: string | null;
  /** Nickname this reply answers (when replying to a reply). */
  replyTo: string | null;
  /** Removed comment kept as a placeholder because it has visible replies. */
  deleted: boolean;
  body: string;
  author: AuthorDto;
  isMine: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PostDetailDto extends PostListItemDto {
  body: string;
  isMine: boolean;
  hands: HandReviewDto[];
  comments: CommentDto[];
}

export interface PostPageDto {
  notices: PostListItemDto[];
  posts: PostListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MyCommentDto {
  id: string;
  body: string;
  postId: string;
  postTitle: string;
  createdAt: number;
}

export interface MessageDto {
  id: string;
  category: MessageCategory;
  title: string;
  body: string;
  fromAdmin: string | null;
  readAt: number | null;
  createdAt: number;
}
