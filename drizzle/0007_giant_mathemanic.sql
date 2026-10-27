CREATE INDEX `members_coach_id_idx` ON `members` (`coach_id`);--> statement-breakpoint
CREATE INDEX `sessions_coach_id_scheduled_at_idx` ON `sessions` (`coach_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `sessions_member_id_scheduled_at_idx` ON `sessions` (`member_id`,`scheduled_at`);