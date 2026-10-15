ALTER TABLE `admin_audit_log` ADD `outcome` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `admin_audit_log` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `admin_audit_log` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_failed_idx` ON `admin_audit_log` (`created_at`) WHERE outcome = 'failed';--> statement-breakpoint
-- Attempts recorded before this column existed.
UPDATE `admin_audit_log` SET `outcome` = 'failed' WHERE `action` IN ('admin.login.failed', 'admin.reauth.failed', 'user.chips_refused');
