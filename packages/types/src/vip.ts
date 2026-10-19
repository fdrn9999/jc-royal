import { z } from 'zod';

// ------------------------------------------------------------------ VIP members

/**
 * VIP is a look, never a permission: an administrator marks an ordinary member as VIP and picks the color their name
 * takes, from this fixed palette only (the client maps a key to its own color tokens; no color value is stored or sent).
 * It changes nothing a member may do or receive: no chips, refills, odds, cards, table or tournament priority, admin
 * access or anyone's private data. Game and economy code never reads it.
 */
export const VIP_COLORS = ['gold', 'rose', 'sapphire', 'amethyst', 'emerald', 'cyan'] as const;
export type VipColor = (typeof VIP_COLORS)[number];
/** The color a new VIP gets unless the administrator picks another first. */
export const VIP_DEFAULT_COLOR: VipColor = 'gold';

export function isVipColor(v: unknown): v is VipColor {
  return typeof v === 'string' && (VIP_COLORS as readonly string[]).includes(v);
}

/**
 * The VIP color other players see for a stored account: only an active, ordinary member who is not a table bot shows
 * one (a suspended member's is hidden until the suspension ends; staff and bots never carry it).
 */
export function shownVip(u: { role?: string | null; status?: string | null; isBot?: boolean | number | null; vipColor?: string | null }): VipColor | undefined {
  if (u.role !== 'user' || u.isBot || (u.status != null && u.status !== 'active')) return undefined;
  return isVipColor(u.vipColor) ? u.vipColor : undefined;
}

/** Why an account cannot be made VIP (the server's refusal codes): staff, table bots and deleted accounts. */
export type VipIneligible = 'staff' | 'bot' | 'deleted';
export function vipIneligible(u: { role?: string | null; status?: string | null; isBot?: boolean | number | null }): VipIneligible | null {
  if (u.isBot) return 'bot';
  if (u.status === 'deleted') return 'deleted';
  if (u.role !== 'user') return 'staff';
  return null;
}

/**
 * PATCH /api/admin/users/:id/vip. `enabled: true` makes the member VIP (in `color`, gold if none) or, when they already
 * are, changes their color; `enabled: false` ends it and takes no color (a color without VIP does not exist).
 * `expectedVersion` is the version the page showed: if someone changed it since, the server refuses (409 vip_conflict)
 * with the state as it is now. Asking for the state the member already has changes nothing. `preview: true` answers
 * with what would change and writes nothing.
 */
const VipChange = z
  .object({
    enabled: z.boolean(),
    color: z.enum(VIP_COLORS).optional(),
    reason: z.string().trim().min(2).max(200),
    expectedVersion: z.number().int().min(0),
    preview: z.boolean().optional(),
  })
  .strict();
const noColorWithoutVip = { message: 'no color without VIP', path: ['color'] };
export const AdminVipSchema = VipChange.refine((v) => v.enabled || v.color === undefined, noColorWithoutVip);
export type AdminVipInput = z.infer<typeof AdminVipSchema>;
/** The preview may come before the reason is typed. */
export const AdminVipPreviewSchema = VipChange.partial({ reason: true }).refine((v) => v.enabled || v.color === undefined, noColorWithoutVip);

/** A member's VIP state in the console (GET /api/admin/users/:id/vip and every answer of the PATCH). */
export interface AdminVipDto {
  member: { id: string; nickname: string; role: string; status: string; isBot: boolean };
  /** The color while VIP; null when not. */
  color: VipColor | null;
  /** Raised by every change (assign, color, end). */
  version: number;
  changedAt: number | null;
  /** The administrator of the last change (the audit log has the whole history). */
  changedBy: { id: string; nickname: string | null } | null;
  /** Why this account cannot be made VIP, or null when it can. */
  ineligible: VipIneligible | null;
}

/** The PATCH's preview: the change as it would be made now, and the tables where the member's name would update. */
export interface AdminVipPreviewDto {
  preview: true;
  from: VipColor | null;
  to: VipColor | null;
  version: number;
  changed: boolean;
  /** Tables where the member sits now. */
  tables: number;
  vip: AdminVipDto;
}

/**
 * The PATCH's answer: the stored state, and the member's tables: how many there are and how many redrew the name at
 * once (the rest catch up when the member next connects).
 */
export interface AdminVipResultDto {
  changed: boolean;
  vip: AdminVipDto;
  tables: number;
  reached: number;
}
