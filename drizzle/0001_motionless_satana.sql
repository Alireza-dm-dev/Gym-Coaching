ALTER TABLE `members` ADD `goal` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `default_start_time` text DEFAULT '10:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `default_duration_minutes` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `preferred_days` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `photo_url` text;