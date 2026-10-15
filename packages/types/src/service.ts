// ------------------------------------------------------------------ service notices & maintenance

export const NOTICE_KINDS = ['general', 'urgent', 'maintenance'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** A service notice in both languages; the reader's language picks one. */
export interface ServiceNoticeDto {
  id: string;
  kind: NoticeKind;
  titleKo: string;
  titleEn: string;
  bodyKo: string | null;
  bodyEn: string | null;
  startsAt: number;
  /** Shown until then; null = until an admin ends it. */
  endsAt: number | null;
  /** The pinned board post written with it, if any. */
  postId: string | null;
}

/**
 * A maintenance window that has not finished. From startsAt to endsAt no one new sits down and no new hand is dealt
 * (a hand already running plays out); with blockLogin, members other than staff cannot sign in or sign up.
 */
export interface MaintenanceDto {
  id: string;
  startsAt: number;
  endsAt: number;
  blockLogin: boolean;
  messageKo: string | null;
  messageEn: string | null;
  /** Under way at `now` of the response. */
  active: boolean;
}

/** GET /api/service/status (no sign-in needed). */
export interface ServiceStatusDto {
  /** Server clock, so the page can start and end notices on time with a skewed device clock. */
  now: number;
  /** Changes whenever an admin changes a notice or a maintenance window (the inbox poll carries it too). */
  rev: number;
  /** Notices showing now, and those starting within a day. */
  notices: ServiceNoticeDto[];
  maintenance: MaintenanceDto | null;
}
