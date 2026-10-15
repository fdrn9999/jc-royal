-- Per-minute counters of rare events for the admin dashboard (packages/db/src/ops.ts). WITHOUT ROWID: the primary key
-- is the table itself, so adding to a minute writes one row and no separate index.
CREATE TABLE `ops_metrics` (
	`bucket` integer NOT NULL,
	`metric` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`bucket`, `metric`)
) WITHOUT ROWID;