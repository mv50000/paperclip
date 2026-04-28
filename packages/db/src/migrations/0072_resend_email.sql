CREATE TABLE "company_email_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"primary_domain" text NOT NULL,
	"sending_domain" text NOT NULL,
	"mail_provider" text DEFAULT 'resend' NOT NULL,
	"resend_domain_id" text,
	"default_from_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"max_per_agent_per_day" integer DEFAULT 50 NOT NULL,
	"max_per_company_per_day" integer DEFAULT 500 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"in_reply_to_id" uuid,
	"from_address" text NOT NULL,
	"to_addresses" text[] NOT NULL,
	"cc_addresses" text[] DEFAULT '{}' NOT NULL,
	"subject" text,
	"body_text" text,
	"body_html_sanitized" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"route_key" text,
	"assigned_agent_id" uuid,
	"issue_id" uuid,
	"status" text NOT NULL,
	"error_message" text,
	"received_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbound_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"to_addresses" text[] NOT NULL,
	"from_address" text NOT NULL,
	"subject" text,
	"template_key" text,
	"suppression_hit" boolean DEFAULT false NOT NULL,
	"rate_limit_hit" boolean DEFAULT false NOT NULL,
	"provider_message_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_rate_limits" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_rate_limits_pk" PRIMARY KEY("company_id","agent_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "email_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"domain" text NOT NULL,
	"route_key" text NOT NULL,
	"assigned_agent_id" uuid,
	"auto_reply_template_id" uuid,
	"escalate_after_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"source_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"locale" text DEFAULT 'fi' NOT NULL,
	"subject_tpl" text,
	"body_md_tpl" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_email_config" ADD CONSTRAINT "company_email_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_in_reply_to_id_email_messages_id_fk" FOREIGN KEY ("in_reply_to_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_audit" ADD CONSTRAINT "email_outbound_audit_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbound_audit" ADD CONSTRAINT "email_outbound_audit_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_rate_limits" ADD CONSTRAINT "email_rate_limits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_routes" ADD CONSTRAINT "email_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_routes" ADD CONSTRAINT "email_routes_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_routes" ADD CONSTRAINT "email_routes_auto_reply_template_id_email_templates_id_fk" FOREIGN KEY ("auto_reply_template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppression_list" ADD CONSTRAINT "email_suppression_list_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppression_list" ADD CONSTRAINT "email_suppression_list_source_message_id_email_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_email_config_company_unique_idx" ON "company_email_config" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_email_config_primary_domain_unique_idx" ON "company_email_config" USING btree ("primary_domain");--> statement-breakpoint
CREATE INDEX "company_email_config_status_idx" ON "company_email_config" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_company_provider_message_unique_idx" ON "email_messages" USING btree ("company_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "email_messages_company_direction_received_idx" ON "email_messages" USING btree ("company_id","direction","received_at");--> statement-breakpoint
CREATE INDEX "email_messages_company_assigned_status_idx" ON "email_messages" USING btree ("company_id","assigned_agent_id","status");--> statement-breakpoint
CREATE INDEX "email_messages_provider_message_idx" ON "email_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "email_outbound_audit_company_agent_created_idx" ON "email_outbound_audit" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "email_outbound_audit_company_status_created_idx" ON "email_outbound_audit" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_routes_company_local_domain_unique_idx" ON "email_routes" USING btree ("company_id","local_part","domain");--> statement-breakpoint
CREATE INDEX "email_routes_domain_idx" ON "email_routes" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppression_list_company_address_unique_idx" ON "email_suppression_list" USING btree ("company_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_company_key_locale_unique_idx" ON "email_templates" USING btree ("company_id","key","locale");