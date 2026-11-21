ALTER TABLE "inbox_item" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox_item" ADD COLUMN "rank" text;