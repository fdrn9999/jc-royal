import { z } from 'zod';

/**
 * Account settings kept on the server (apps/api/src/lib/settings.ts) so every device signed in to the account shows
 * them: the table look and aids, and the favourite tables. What belongs to one device stays there (sound and whether
 * the browser may play it, recently opened tables, the install offer); the language was already the account's.
 */

/** Table looks: the same list as THEMES in @jc/ui (a web unit test keeps the two equal). */
export const SETTINGS_THEMES = ['royal', 'emerald', 'crimson', 'sapphire'] as const;
export const SETTINGS_AMOUNT_UNITS = ['chips', 'bb'] as const;
/**
 * Colour vision modes (packages/ui/src/styles.css `[data-cv]`): the meaning colours (success, danger, warning, info),
 * the suits and the action buttons switch to colours told apart in that mode. Independent of the theme, the four-colour
 * deck, the beginner aids and reduced motion.
 */
export const SETTINGS_COLOR_VISIONS = ['normal', 'protan', 'deutan', 'tritan', 'highContrast'] as const;
export type ColorVision = (typeof SETTINGS_COLOR_VISIONS)[number];
/** The friends list order: by status (online, away, offline) or by the newest message. */
export const SETTINGS_FRIEND_SORTS = ['presence', 'recent'] as const;

export const SyncedPrefsSchema = z.object({
  theme: z.enum(SETTINGS_THEMES),
  fourColor: z.boolean(),
  /** A second tap for fold-when-check-is-free, large calls and all-in. */
  confirmRisky: z.boolean(),
  /** Beginner aids at the table. */
  beginner: z.boolean(),
  /**
   * No longer used: auto-muck always applies at every table and the setting is gone from the page. Kept so a save from
   * an older page (which still sends it) is accepted; nothing reads it.
   */
  autoMuck: z.boolean(),
  amountUnit: z.enum(SETTINGS_AMOUNT_UNITS),
  /** Quick emoji reactions shown and sent. */
  reactions: z.boolean(),
  colorVision: z.enum(SETTINGS_COLOR_VISIONS),
  friendSort: z.enum(SETTINGS_FRIEND_SORTS),
  /** A short vibration when it becomes my turn to act (where the device can vibrate). */
  turnVibrate: z.boolean(),
  /**
   * My current hand at the table (my own cards and the board shown so far: the starting hand's name before the flop, the
   * made hand after). Shown with the beginner aids too, once.
   */
  showHand: z.boolean(),
});
export type SyncedPrefs = z.infer<typeof SyncedPrefsSchema>;
export type SyncedPrefKey = keyof SyncedPrefs;
export const SYNCED_PREF_KEYS = Object.keys(SyncedPrefsSchema.shape) as SyncedPrefKey[];
/** What a device shows for a setting the account has no value for. */
export const SYNCED_PREF_DEFAULTS: SyncedPrefs = { theme: 'royal', fourColor: false, confirmRisky: true, beginner: false, autoMuck: false, amountUnit: 'chips', reactions: true, colorVision: 'normal', friendSort: 'presence', turnVibrate: false, showHand: true };

/** Most favourite tables an account keeps (the newest win). */
export const SETTINGS_FAV_MAX = 50;
/** The stored format; a row of another version is read through a migration (none yet). */
export const SETTINGS_SCHEMA_VERSION = 1;
/** How long ago a change sent now may say it was made (a device offline longer counts it as made this long ago). */
export const SETTINGS_MAX_AGO_MS = 30 * 86_400_000;
/** An administrator's reset can be undone this long, while the member has changed nothing since. */
export const SETTINGS_RESTORE_MS = 7 * 86_400_000;

/** GET/PUT /api/me/settings. */
export interface SettingsDto {
  /** Raised by an administrator's reset or restore: a device holding another epoch drops what it has not saved. */
  epoch: number;
  /** Raised by every change; a save names the one it was made over (`base`). 0 before the first save. */
  rev: number;
  /** The settings the account has a value for (the rest show the default). */
  prefs: Partial<SyncedPrefs>;
  /** Favourite table ids, newest first. */
  fav: string[];
  updatedAt: number | null;
}

/** Milliseconds since the change was made on the device: the server dates it by its own clock, so device clocks don't matter. */
const ago = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const change = <T extends z.ZodType>(v: T) => z.object({ v, ago }).strict().optional();
const tableId = z.string().min(1).max(64);

/**
 * PUT /api/me/settings. Each setting and favourite sent is taken unless the account has a newer change for it (made
 * later on another device): the newest change wins, one setting or table at a time. `legacy` is what this device had
 * before settings were kept on the account: it only fills settings and tables the account has nothing for, and only
 * while no administrator has reset the account's settings (epoch 0). An `epoch` other than the account's is refused
 * (409 settings_reset, with the account's settings in details). `fails`: attempts that failed on the device since its
 * last answer (counted for operations statistics). `user`: the account the device made the changes in; another account
 * signed in meanwhile (in another tab) is refused (409 settings_account), so one account's changes never reach another.
 */
export const SettingsSaveSchema = z
  .object({
    user: z.string().min(1).max(64),
    epoch: z.number().int().min(0),
    base: z.number().int().min(0),
    prefs: z
      .object({
        theme: change(z.enum(SETTINGS_THEMES)),
        fourColor: change(z.boolean()),
        confirmRisky: change(z.boolean()),
        beginner: change(z.boolean()),
        autoMuck: change(z.boolean()),
        amountUnit: change(z.enum(SETTINGS_AMOUNT_UNITS)),
        reactions: change(z.boolean()),
        colorVision: change(z.enum(SETTINGS_COLOR_VISIONS)),
        friendSort: change(z.enum(SETTINGS_FRIEND_SORTS)),
        turnVibrate: change(z.boolean()),
        showHand: change(z.boolean()),
      })
      .strict()
      .optional(),
    fav: z
      .array(z.object({ id: tableId, on: z.boolean(), ago }).strict())
      .max(SETTINGS_FAV_MAX * 2)
      .optional(),
    legacy: z
      .object({ prefs: SyncedPrefsSchema.partial().strict().optional(), fav: z.array(tableId).max(SETTINGS_FAV_MAX).optional() })
      .strict()
      .optional(),
    fails: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();
export type SettingsSave = z.infer<typeof SettingsSaveSchema>;

export interface SettingsSaveResult {
  settings: SettingsDto;
  /** Settings and tables sent that a newer change on another device kept (the account's value is in `settings`). */
  kept: string[];
}

/** An administrator's view of a member's settings: never their values, only what diagnosing a problem needs. */
export interface AdminSettingsDiagDto {
  member: { nickname: string; role: string; status: string };
  /** False when the account never saved settings (its devices show defaults or what each had before). */
  exists: boolean;
  rev: number;
  epoch: number;
  schemaVersion: number | null;
  /** How many settings the account has a value for, of SYNCED_PREF_KEYS. */
  fields: number;
  favourites: number;
  updatedAt: number | null;
  /** The member's devices last loaded or saved them (to about ten minutes). */
  syncedAt: number | null;
  reset: {
    at: number;
    by: { id: string; nickname: string | null } | null;
    /** Until when it can be undone; null when it can't be (expired, already undone, or the member changed something since). */
    restorableUntil: number | null;
    /** When it was undone. */
    restoredAt: number | null;
  } | null;
}
