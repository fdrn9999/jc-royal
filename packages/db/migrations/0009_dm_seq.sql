ALTER TABLE `direct_messages` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Number the messages already saved, per conversation, in the order the app has shown them so far (time, then id).
UPDATE `direct_messages` SET `seq` = (
  SELECT COUNT(*) FROM `direct_messages` AS `d`
   WHERE `d`.`pair_key` = `direct_messages`.`pair_key`
     AND (`d`.`created_at` < `direct_messages`.`created_at`
          OR (`d`.`created_at` = `direct_messages`.`created_at` AND `d`.`id` <= `direct_messages`.`id`))
);--> statement-breakpoint
CREATE UNIQUE INDEX `dm_pair_seq_uq` ON `direct_messages` (`pair_key`,`seq`);
