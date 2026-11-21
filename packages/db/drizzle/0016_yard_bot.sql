CREATE TABLE "yard_bot" (
	"user_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"made_by" text NOT NULL,
	"reads_log" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "yard_bot" ADD CONSTRAINT "yard_bot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yard_bot" ADD CONSTRAINT "yard_bot_made_by_user_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "yard_bot_made_by_idx" ON "yard_bot" USING btree ("made_by");