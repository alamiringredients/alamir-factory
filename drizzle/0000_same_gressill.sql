CREATE TABLE `members` (
	`email` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ownership` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demo` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`history` text NOT NULL,
	`created_at` text NOT NULL
);
