CREATE TABLE IF NOT EXISTS "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768) NOT NULL
);
