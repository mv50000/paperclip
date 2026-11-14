-- RK9 Ads organic posts (migration 006, RK9-832 / epic RK9-828).
-- No quote characters in these comments: the host validator strips quoted text before it drops comments.
--
-- Organic (unpaid) Instagram and Facebook Page posts from a staged creative.
-- A post is published only from an approved Telegram card of the gate kind
-- organic_publish; there is no other publish path (tests/organic-sole-path.spec.ts).
--
-- Numbering: 002-005 stay reserved for A7, A10, A11 and A9 (README section Data).
-- This file takes 006. Never edit it after it has been applied anywhere: the
-- host records a checksum per file and refuses a changed migration.
--
-- The migration validator of the host allows ALTER TABLE, so the gate kind CHECK of
-- migration 001 is replaced here instead of editing 001. The constraint name is
-- the one Postgres gives an inline column CHECK: <table>_<column>_check.

ALTER TABLE plugin_rk9_ads_6c2f16bb07.gate_requests DROP CONSTRAINT gate_requests_kind_check;

ALTER TABLE plugin_rk9_ads_6c2f16bb07.gate_requests ADD CONSTRAINT gate_requests_kind_check
  CHECK (kind IN ('activate_ad', 'pause_all', 'organic_publish'));

-- One row per requested post (one card). content_hash covers the company, the
-- sha256 of the creative, the channel and the caption, so a changed caption is a
-- new post with a new card. meta_media_id is the object a delete removes: the
-- IG media id, the FB photo id or the FB video id.
CREATE TABLE plugin_rk9_ads_6c2f16bb07.organic_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  brand_code text NOT NULL,
  creative_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('ig_reel', 'ig_feed', 'fb_video', 'fb_photo')),
  caption text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected', 'expired', 'publishing', 'published', 'dry_run', 'failed', 'deleted')),
  mode text NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'live')),
  gate_request_id uuid,
  lint jsonb,
  meta_container_id text,
  meta_media_id text,
  meta_post_id text,
  permalink text,
  reject_reason_code text,
  reject_reason_text text,
  decided_by_tg_user_id bigint,
  decided_at timestamptz,
  published_at timestamptz,
  deleted_at timestamptz,
  deleted_by text,
  error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organic_posts_company_row_key UNIQUE (company_id, id),
  CONSTRAINT organic_posts_creative_fk FOREIGN KEY (company_id, creative_id)
    REFERENCES plugin_rk9_ads_6c2f16bb07.creatives (company_id, id),
  CONSTRAINT organic_posts_gate_request_fk FOREIGN KEY (company_id, gate_request_id)
    REFERENCES plugin_rk9_ads_6c2f16bb07.gate_requests (company_id, id)
);

-- At most one open post (card waiting, publishing or live) per content.
CREATE UNIQUE INDEX organic_posts_open_content_key
  ON plugin_rk9_ads_6c2f16bb07.organic_posts (company_id, content_hash)
  WHERE status IN ('pending', 'publishing', 'published');

CREATE INDEX organic_posts_company_updated_idx
  ON plugin_rk9_ads_6c2f16bb07.organic_posts (company_id, updated_at);
