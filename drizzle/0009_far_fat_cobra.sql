CREATE TABLE `member_meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` integer NOT NULL,
	`logged_at` text NOT NULL,
	`meal_type` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "member_meals_meal_type_check" CHECK("member_meals"."meal_type" IN ('breakfast', 'lunch', 'dinner', 'snack'))
);
--> statement-breakpoint
CREATE INDEX `member_meals_member_id_logged_at_idx` ON `member_meals` (`member_id`,`logged_at`);