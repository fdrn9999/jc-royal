/**
 * The newest social policy (social_policies) as one JSON value, for a subselect: null before any version exists. The
 * game-worker reads it with the table and with each hand record, the api when a reply would show a staff role; both
 * parse it with toSocialPolicy (@jc/types), which falls back to the defaults for anything it cannot read.
 */
export const SOCIAL_POLICY_JSON = `SELECT json_object('version', version, 'reactionsEnabled', reactions_enabled, 'cooldownMs', reaction_cooldown_ms,
  'burstMax', reaction_burst_max, 'burstWindowMs', reaction_burst_window_ms, 'showSuperAdmin', show_super_admin, 'showAdmin', show_admin)
  FROM social_policies ORDER BY version DESC LIMIT 1`;
