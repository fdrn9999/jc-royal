import { z } from 'zod';

/**
 * Web Push notifications (apps/api/src/lib/notify.ts, apps/web/public/sw.js). Three separate things decide whether a
 * member gets one: the account's service consent (and night consent for 21:00–08:00 Korean time), the account's choice
 * per type, and this browser's own permission and subscription. Only service notices: never marketing, never "a
 * friend came online".
 */

/** The kinds of push a member can get, each with its own switch (all on once service consent is given). */
export const NOTIFICATION_TYPES = ['dm', 'invite', 'friendRequest', 'friendAccepted', 'tournamentStart', 'tournamentCancel', 'tournamentResult'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** The column / outbox name of each type. */
export const NOTIFICATION_TYPE_DB: Record<NotificationType, 'dm' | 'invite' | 'friend_request' | 'friend_accepted' | 'tournament_start' | 'tournament_cancel' | 'tournament_result'> = {
  dm: 'dm',
  invite: 'invite',
  friendRequest: 'friend_request',
  friendAccepted: 'friend_accepted',
  tournamentStart: 'tournament_start',
  tournamentCancel: 'tournament_cancel',
  tournamentResult: 'tournament_result',
};
export type NotificationDbType = (typeof NOTIFICATION_TYPE_DB)[NotificationType];

/** The wording of the two consents (SignupConsent, the notification settings); recorded with every change. */
export const NOTIFICATION_CONSENT_VERSION = '2026-10-19';

/** Korean night: from 21:00 to 08:00 Asia/Seoul (no daylight saving), judged on the server's clock only. */
export const KST_NIGHT_START_HOUR = 21;
export const KST_NIGHT_END_HOUR = 8;
const KST_OFFSET_MS = 9 * 3_600_000;
/** The hour (0–23) in Korea at `ms`. */
export function kstHour(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / 3_600_000) % 24;
}
/** 20:59:59 is day, 21:00:00 night, 07:59:59 night, 08:00:00 day. */
export function isKstNight(ms: number): boolean {
  const h = kstHour(ms);
  return h >= KST_NIGHT_START_HOUR || h < KST_NIGHT_END_HOUR;
}

/** GET/PUT /api/me/notifications/settings: the account's, the same on every device. */
export interface NotificationSettingsDto {
  /** "[선택] 서비스 푸시 알림 수신 동의". */
  service: boolean;
  /** "[선택] 야간 서비스 푸시 알림 수신 동의" (counts only with service). */
  night: boolean;
  types: Record<NotificationType, boolean>;
  /** Raised by every change; a change names the version it was made from. 0: never changed. */
  version: number;
  serviceAt: number | null;
  nightAt: number | null;
  updatedAt: number | null;
  /** Whether this server can send pushes at all (keys configured). */
  pushAvailable: boolean;
}
export const NOTIFICATION_DEFAULTS: Omit<NotificationSettingsDto, 'pushAvailable'> = {
  service: false,
  night: false,
  types: { dm: true, invite: true, friendRequest: true, friendAccepted: true, tournamentStart: true, tournamentCancel: true, tournamentResult: true },
  version: 0,
  serviceAt: null,
  nightAt: null,
  updatedAt: null,
};

/**
 * PUT /api/me/notifications/settings. Only what is sent changes. `expectedVersion` is the version the device showed:
 * another is refused (409 stale_settings, the account's settings in details), so a device that has not seen a
 * withdrawal made elsewhere cannot give the consent again by saving.
 */
export const NotificationSettingsSaveSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    service: z.boolean().optional(),
    night: z.boolean().optional(),
    types: z.object(Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, z.boolean().optional()])) as Record<NotificationType, z.ZodOptional<z.ZodBoolean>>).strict().optional(),
  })
  .strict();
export type NotificationSettingsSave = z.infer<typeof NotificationSettingsSaveSchema>;

/** Signup's two optional consents (both off unless ticked; signing up never needs them). */
export const PushConsentSchema = z.object({ service: z.boolean(), night: z.boolean() }).strict();

/** Base64url without padding, as PushSubscription.toJSON() gives the keys. */
const b64url = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/);

/**
 * POST /api/me/notifications/subscriptions: this browser's subscription, for the member and the sign-in it is made in.
 * The endpoint must be a known push service over HTTPS (apps/api/src/lib/webpush.ts allowedEndpoint).
 * `oldEndpoint`: the subscription it replaces (the service worker's pushsubscriptionchange).
 */
export const PushSubscribeSchema = z
  .object({
    endpoint: z.string().min(16).max(1024),
    keys: z.object({ p256dh: b64url(80, 100), auth: b64url(16, 32) }).strict(),
    expirationTime: z.number().nullable().optional(),
    oldEndpoint: z.string().min(16).max(1024).optional(),
  })
  .strict();
export type PushSubscribe = z.infer<typeof PushSubscribeSchema>;

/** POST /api/me/notifications/subscriptions/remove: this browser stops (by its endpoint, which only it knows). */
export const PushUnsubscribeSchema = z.object({ endpoint: z.string().min(16).max(1024) }).strict();

/** GET /api/me/notifications/devices: the member's browsers that get pushes, never their endpoints. */
export interface PushDeviceDto {
  id: string;
  /** "Chrome · Android" from the browser's description; null when it can't tell. */
  label: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** Registered in this sign-in. */
  current: boolean;
}
export interface PushDevicesDto {
  devices: PushDeviceDto[];
}
/**
 * POST /api/me/notifications/subscriptions answer, with the server's public key: a page that finds its subscription
 * made with another (the key pair was replaced) subscribes again.
 */
export interface PushSubscribeResult {
  device: PushDeviceDto;
  publicKey: string;
}

/** Devices one member may register (the oldest goes when another is added). */
export const PUSH_MAX_DEVICES = 10;

/**
 * What a push carries, encrypted to the browser (RFC 8291): generic words only, never a message's text, a card or an
 * amount. `to`: the member it is for; the service worker drops it when another account signed in there since.
 * `url`: an internal path the click opens.
 */
export interface PushPayload {
  t: NotificationType;
  title: string;
  body: string;
  /** The language of the words (the member's). */
  lang: 'ko' | 'en';
  url: string;
  to: string;
  tag: string;
  ts: number;
}

/** The page tells its service worker who is signed in (null: nobody), so a push for someone else is never shown. */
export interface SwOwnerMessage {
  type: 'jc-owner';
  uid: string | null;
}
/** The service worker asks an open page to go to a push's path inside the app. */
export interface SwNavigateMessage {
  type: 'jc-navigate';
  url: string;
}
