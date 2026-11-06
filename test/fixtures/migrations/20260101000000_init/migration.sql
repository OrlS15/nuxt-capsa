CREATE TABLE "users" (
	"id" serial PRIMARY KEY,
	"email" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");