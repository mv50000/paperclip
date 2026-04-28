CREATE TABLE "risk_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"domain" text NOT NULL,
	"default_severity" text NOT NULL,
	"is_builtin" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"likelihood" text DEFAULT 'possible' NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'monitor' NOT NULL,
	"source_monitor" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_evaluated" timestamp with time zone DEFAULT now() NOT NULL,
	"mitigated_at" timestamp with time zone,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"evidence_json" jsonb,
	"mitigation_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"risk_entry_id" uuid,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"playbook_code" text,
	"auto_actions" jsonb,
	"manual_actions" jsonb,
	"timeline_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_to" text,
	"approval_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category_code" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold_json" jsonb NOT NULL,
	"auto_actions" jsonb,
	"escalation_sev" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"overall_score" integer NOT NULL,
	"domain_scores" jsonb NOT NULL,
	"open_risks" integer NOT NULL,
	"open_incidents" integer NOT NULL,
	"details_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_categories" ADD CONSTRAINT "risk_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_entries" ADD CONSTRAINT "risk_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_entries" ADD CONSTRAINT "risk_entries_category_id_risk_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."risk_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incidents" ADD CONSTRAINT "risk_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incidents" ADD CONSTRAINT "risk_incidents_risk_entry_id_risk_entries_id_fk" FOREIGN KEY ("risk_entry_id") REFERENCES "public"."risk_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_incidents" ADD CONSTRAINT "risk_incidents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_policies" ADD CONSTRAINT "risk_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_snapshots" ADD CONSTRAINT "risk_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_categories_company_code_unique_idx" ON "risk_categories" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "risk_categories_domain_idx" ON "risk_categories" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "risk_entries_company_status_severity_idx" ON "risk_entries" USING btree ("company_id","status","severity");--> statement-breakpoint
CREATE INDEX "risk_entries_company_scope_idx" ON "risk_entries" USING btree ("company_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "risk_entries_company_category_status_idx" ON "risk_entries" USING btree ("company_id","category_id","status");--> statement-breakpoint
CREATE INDEX "risk_incidents_company_status_severity_idx" ON "risk_incidents" USING btree ("company_id","status","severity");--> statement-breakpoint
CREATE INDEX "risk_incidents_risk_entry_idx" ON "risk_incidents" USING btree ("risk_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_policies_company_category_unique_idx" ON "risk_policies" USING btree ("company_id","category_code");--> statement-breakpoint
CREATE INDEX "risk_snapshots_company_snapshot_idx" ON "risk_snapshots" USING btree ("company_id","snapshot_at");