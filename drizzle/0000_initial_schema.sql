CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_slug_format_check" CHECK ("projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "specifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specifications_key_unique" UNIQUE("key"),
	CONSTRAINT "specifications_key_format_check" CHECK ("specifications"."key" ~ '^SPEC-[0-9]{3,}$'),
	CONSTRAINT "specifications_status_check" CHECK ("specifications"."status" IN ('draft', 'in-review', 'approved'))
);
--> statement-breakpoint
ALTER TABLE "specifications" ADD CONSTRAINT "specifications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "specifications_project_id_idx" ON "specifications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "specifications_updated_at_key_idx" ON "specifications" USING btree ("updated_at" DESC NULLS LAST,"key");