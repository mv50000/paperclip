-- RK9 Ads ledger (migration 001, RK9-507 / epic RK9-505 G11).
--
-- The schema name is derived by the host from the manifest id:
--   plugin_ + namespaceSlug + _ + sha256("rk9-ads").slice(0, 10)
-- tests/manifest.spec.ts recomputes it, so a PLUGIN_ID rename fails loudly.
-- Never edit this file after it has been applied anywhere: the host records a
-- checksum per file and refuses a changed migration. New tables go to the
-- reserved files 002 (A7), 003 (A10), 004 (A11) and 005 (A9).
--
-- Every table carries company_id and every runtime query filters on it.
-- A link between ledger rows is a composite (company_id, <row id>) foreign
-- key, so a row can never point at a row of another company.
-- Status columns use CHECK constraints with the final status sets.

CREATE TABLE plugin_rk9_ads_6c2f16bb07.brand_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  ad_account_id text NOT NULL,
  page_id text NOT NULL,
  ig_user_id text,
  dataset_id text,
  campaign_id text,
  adset_id text,
  binding_source text NOT NULL DEFAULT 'provisioned' CHECK (binding_source IN ('provisioned', 'adopted')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_bindings_company_brand_key UNIQUE (company_id, brand_code)
);

CREATE TABLE plugin_rk9_ads_6c2f16bb07.creatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  sha256 text NOT NULL,
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('video', 'image')),
  aspect_ratio text,
  media_url text NOT NULL,
  thumbnail_url text,
  ad_copy jsonb NOT NULL DEFAULT '{}'::jsonb,
  cta text,
  landing_url_key text,
  utm_campaign text,
  target_adset_id text,
  valid_until timestamptz,
  meta_video_id text,
  meta_image_hash text,
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'uploading', 'ready', 'published', 'rejected', 'expired', 'failed')),
  error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creatives_company_brand_sha256_key UNIQUE (company_id, brand_code, sha256),
  CONSTRAINT creatives_company_idempotency_key UNIQUE (company_id, idempotency_key),
  CONSTRAINT creatives_company_row_key UNIQUE (company_id, id)
);

-- idempotency_key is unique across the table. Callers derive it from a hash
-- that includes company_id, so two companies can never collide on it.
CREATE TABLE plugin_rk9_ads_6c2f16bb07.publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  creative_id uuid,
  idempotency_key text NOT NULL,
  content_hash text NOT NULL,
  mode text NOT NULL DEFAULT 'publish' CHECK (mode IN ('publish', 'swap')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed', 'swapped')),
  ad_name text,
  campaign_id text,
  adset_id text,
  meta_video_id text,
  meta_image_hash text,
  meta_creative_id text,
  meta_ad_id text,
  replaces_publication_id uuid,
  error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publications_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT publications_company_row_key UNIQUE (company_id, id),
  CONSTRAINT publications_creative_fk FOREIGN KEY (company_id, creative_id)
    REFERENCES plugin_rk9_ads_6c2f16bb07.creatives (company_id, id),
  CONSTRAINT publications_replaces_fk FOREIGN KEY (company_id, replaces_publication_id)
    REFERENCES plugin_rk9_ads_6c2f16bb07.publications (company_id, id)
);

-- The plugin-owned spend gate (G1). A token is single-use, random (>= 128 bit)
-- and unique across the table, because a Telegram callback carries only the token.
CREATE TABLE plugin_rk9_ads_6c2f16bb07.gate_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('activate_ad', 'pause_all')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'skipped', 'expired', 'failed')),
  token text NOT NULL,
  publication_id uuid,
  ad_id text,
  adset_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  chat_id text,
  message_id bigint,
  valid_until timestamptz NOT NULL,
  decided_by_tg_user_id bigint,
  decided_at timestamptz,
  outcome jsonb,
  paused_ad_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gate_requests_token_key UNIQUE (token),
  CONSTRAINT gate_requests_company_row_key UNIQUE (company_id, id),
  CONSTRAINT gate_requests_publication_fk FOREIGN KEY (company_id, publication_id)
    REFERENCES plugin_rk9_ads_6c2f16bb07.publications (company_id, id)
);

CREATE INDEX gate_requests_company_status_valid_idx
  ON plugin_rk9_ads_6c2f16bb07.gate_requests (company_id, status, valid_until);

CREATE TABLE plugin_rk9_ads_6c2f16bb07.rule_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  rule_id text NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('threshold_pause', 'pause_all_cap', 'pause_valid_until', 'pause_fatigued', 'propose_scale', 'scheduled_pause', 'data_gate', 'kill_switch')),
  object_type text NOT NULL CHECK (object_type IN ('account', 'campaign', 'adset', 'ad')),
  object_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('pause', 'pause_all', 'propose_scale', 'none')),
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'live')),
  source text NOT NULL DEFAULT 'job' CHECK (source IN ('job', 'ui', 'telegram', 'agent')),
  dry_run boolean NOT NULL DEFAULT true,
  applied boolean NOT NULL DEFAULT false,
  reason text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  gate_request_id uuid,
  error text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_actions_gate_request_fk FOREIGN KEY (company_id, gate_request_id)
    REFERENCES plugin_rk9_ads_6c2f16bb07.gate_requests (company_id, id)
);

CREATE INDEX rule_actions_company_rule_object_decided_idx
  ON plugin_rk9_ads_6c2f16bb07.rule_actions (company_id, rule_id, object_id, decided_at);

-- One row per ad per local (Europe/Helsinki) day. Money is in the ad account
-- currency. CPC is spend / inline_link_clicks (G18); cpc stores that value.
CREATE TABLE plugin_rk9_ads_6c2f16bb07.insights_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  ad_id text NOT NULL,
  date date NOT NULL,
  campaign_id text,
  adset_id text,
  currency text,
  spend numeric(14, 2) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  reach bigint NOT NULL DEFAULT 0,
  frequency numeric(10, 4),
  clicks bigint NOT NULL DEFAULT 0,
  inline_link_clicks bigint NOT NULL DEFAULT 0,
  ctr numeric(10, 4),
  cpc numeric(14, 4),
  cpm numeric(14, 4),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_final boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insights_daily_company_ad_date_key UNIQUE (company_id, ad_id, date)
);

CREATE TABLE plugin_rk9_ads_6c2f16bb07.digest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  digest_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  chat_id text,
  message_id bigint,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digest_runs_company_date_key UNIQUE (company_id, digest_date)
);

-- Once-only markers: cap alerts (brand + local month + threshold), the
-- scheduled pause (brand + local date), token-error alerts and similar.
CREATE TABLE plugin_rk9_ads_6c2f16bb07.alert_dedupe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_dedupe_company_key UNIQUE (company_id, dedupe_key)
);

-- Telegram update ids already handled, per company and bot. bot_key is a hash
-- of the bot token, never the token itself.
CREATE TABLE plugin_rk9_ads_6c2f16bb07.processed_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bot_key text NOT NULL,
  update_id bigint NOT NULL,
  update_kind text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processed_updates_company_bot_update_key UNIQUE (company_id, bot_key, update_id)
);
