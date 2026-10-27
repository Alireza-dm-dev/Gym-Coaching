ALTER TABLE `members` ADD `goal` text NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `default_start_time` text NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `default_duration_minutes` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `preferred_days` text NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `photo_url` text;