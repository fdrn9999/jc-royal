CREATE TABLE `challenge_completions` (
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`period` integer NOT NULL,
	`points` integer NOT NULL,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `code`, `period`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
