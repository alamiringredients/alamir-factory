CREATE TABLE `production_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`demo` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL
);
