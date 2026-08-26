-- Effective Education Hub — core schema
-- Run once via `npm run migrate` (see db/migrate.js) against your Postgres DATABASE_URL.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('student','teacher','publisher','seller','admin')),
  batch_id        TEXT,
  is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  nid_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  bank_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id                SERIAL PRIMARY KEY,
  title             TEXT NOT NULL,
  teacher_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category          TEXT,
  price             NUMERIC(10,2) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  ai_quality_score  INTEGER,
  rating            NUMERIC(2,1),
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS enrollments (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, course_id)
);

-- Books (publisher) and Mart items (seller) share this table, distinguished by `type`.
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('book','mart')),
  title       TEXT NOT NULL,
  category    TEXT,
  price       NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','out_of_stock','archived')),
  rating      NUMERIC(2,1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source      TEXT NOT NULL CHECK (source IN ('course','book','mart')),
  course_id   INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  amount      NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id                SERIAL PRIMARY KEY,
  teacher_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_sales       NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_cut_pct  NUMERIC(5,2) NOT NULL DEFAULT 20,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  period_label      TEXT,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_products_owner ON products(owner_id);
CREATE INDEX IF NOT EXISTS idx_orders_course ON orders(course_id);
CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);

-- Safety net: if this schema is re-run against a DB created by an earlier
-- version of this file (before products/course_id/product_id/rating existed),
-- these add the missing pieces without touching existing data.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;

-- ══════════════════════════════════════════════════════
-- 🧸 KIDS LEARNING WING — trilingual module content
-- (frontend currently ships its own static content in index.html;
-- these tables let that content move to the database later without
-- a frontend rewrite — see routes/kids.js)
-- ══════════════════════════════════════════════════════
DO $$ BEGIN
  CREATE TYPE kids_language AS ENUM ('bn','en','ar');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE kids_access_tier AS ENUM ('free','premium');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS kids_categories (
  id              SERIAL PRIMARY KEY,
  category_key    TEXT NOT NULL UNIQUE, -- 'phonics','tracing','cvc','math','sensory','science','rhymes','ethics','abacus','brain','worksheets'
  title_bn        TEXT NOT NULL,
  title_en        TEXT NOT NULL,
  title_ar        TEXT,
  icon_symbol     TEXT DEFAULT '🎈',
  display_order   INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kids_modules (
  id              SERIAL PRIMARY KEY,
  category_id     INT NOT NULL REFERENCES kids_categories(id) ON DELETE CASCADE,
  language        kids_language NOT NULL DEFAULT 'bn',
  title           TEXT NOT NULL,
  description     TEXT,
  thumbnail_url   TEXT,
  access_level    kids_access_tier NOT NULL DEFAULT 'free',
  min_age         INT NOT NULL DEFAULT 2,
  max_age         INT NOT NULL DEFAULT 8,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kids_contents (
  id                      SERIAL PRIMARY KEY,
  module_id               INT NOT NULL REFERENCES kids_modules(id) ON DELETE CASCADE,
  content_title           TEXT NOT NULL,
  content_type            TEXT NOT NULL, -- 'canvas_game','abacus_quiz','pdf_worksheet','vod_video','audio_letter'
  media_url               TEXT,
  audio_pronunciation_url TEXT,
  game_payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  sequence_order          INT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kids_modules_lang ON kids_modules(language);
CREATE INDEX IF NOT EXISTS idx_kids_modules_cat ON kids_modules(category_id);
CREATE INDEX IF NOT EXISTS idx_kids_contents_module ON kids_contents(module_id);

-- ══════════════════════════════════════════════════════
-- 🌐 MULTI-WING PLATFORM + PERSONALIZED FEED
-- (wings, contents, and per-user engagement — powers /contents and /feed)
-- ══════════════════════════════════════════════════════

-- Every page/section of the SPA is a "wing". Kept as TEXT (not ENUM) on
-- purpose — a new wing shouldn't need a schema migration, just a new row
-- in `wings` and content rows pointing at its key.
CREATE TABLE IF NOT EXISTS wings (
  id              SERIAL PRIMARY KEY,
  wing_key        TEXT NOT NULL UNIQUE, -- matches index.html's page ids: 'academy','kids','news',...
  title_bn        TEXT NOT NULL,
  title_en        TEXT NOT NULL,
  icon_symbol     TEXT DEFAULT '📘',
  display_order   INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE content_kind AS ENUM ('video','game','article','post','audio','worksheet');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One generic table for every feed-able item across every wing (a Kids
-- Phonics game, an Academy lesson video, a Community post, a News
-- article...). wing_type + category_key isolate it to the right wing;
-- `tags` is what interest-matching in the feed query runs against.
CREATE TABLE IF NOT EXISTS contents (
  id              BIGSERIAL PRIMARY KEY,
  wing_type       TEXT NOT NULL REFERENCES wings(wing_key),
  category_key    TEXT NOT NULL,
  content_kind    content_kind NOT NULL DEFAULT 'article',
  title           TEXT NOT NULL,
  body            TEXT,
  media_url       TEXT,
  thumbnail_url   TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}', -- matched against users.interests for personalization
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb, -- game configs, quiz data, etc. — shape varies per content_kind
  author_id       INT REFERENCES users(id) ON DELETE SET NULL,
  like_count      INT NOT NULL DEFAULT 0,   -- denormalized counters, kept in sync by the /like endpoint
  view_count      INT NOT NULL DEFAULT 0,   -- (cheaper to read on every feed request than COUNT()-ing user_activities)
  is_published    BOOLEAN NOT NULL DEFAULT TRUE,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every view/like/share/watch event. This is the raw log the feed's
-- engagement score is ultimately built from (like_count/view_count above
-- are a denormalized cache of aggregates from this table).
CREATE TABLE IF NOT EXISTS user_activities (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id      BIGINT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  activity_type   TEXT NOT NULL CHECK (activity_type IN ('view','like','unlike','share','complete','watch_time')),
  watch_seconds   INT, -- only set when activity_type = 'watch_time'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Personalization inputs, added to the existing users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_wings TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_contents_wing_published ON contents(wing_type, published_at DESC) WHERE is_published;
CREATE INDEX IF NOT EXISTS idx_contents_category ON contents(category_key);
CREATE INDEX IF NOT EXISTS idx_contents_tags ON contents USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_activities_user_content ON user_activities(user_id, content_id);
CREATE INDEX IF NOT EXISTS idx_activities_content ON user_activities(content_id);
-- One 'view' (or any single type) per user per content per activity_type
-- is enough for scoring — this also makes the like/unlike toggle logic safe.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_activity_user_content_type
  ON user_activities(user_id, content_id, activity_type) WHERE activity_type IN ('view','like');

