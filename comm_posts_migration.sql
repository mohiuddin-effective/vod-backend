-- Run this in Supabase SQL Editor to add rich-post fields to comm_posts.
-- Safe to run even if some columns already exist (IF NOT EXISTS guards).

ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS media_url    TEXT;              -- photo/video (data URL for now)
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS media_type   TEXT;              -- 'image' | 'video'
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS feeling      TEXT;              -- e.g. "😊 excited"
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS location_tag TEXT;              -- free-text place name
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS music_tag    TEXT;              -- e.g. "🎵 Lo-fi beats"
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS event_title  TEXT;
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS event_date   TEXT;
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS event_place  TEXT;
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS tagged_names TEXT[] DEFAULT '{}';
ALTER TABLE comm_posts ADD COLUMN IF NOT EXISTS is_live      BOOLEAN DEFAULT false;
