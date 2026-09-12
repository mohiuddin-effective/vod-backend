const express = require('express');
const pool = require('../db/pool');
const cache = require('../lib/cache');
const { optionalAuth, requireAuth } = require('../middleware/auth');

const router = express.Router();

const PAGE_SIZE = 10; // "১০টি করে কন্টেন্ট" — matches the requested IntersectionObserver page size

function parsePage(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  // Optional ?limit= override (capped 1-20) — used by the homepage's small
  // per-wing preview sections; /feed doesn't pass this, so it keeps PAGE_SIZE.
  const limit = req.query.limit ? Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || PAGE_SIZE)) : PAGE_SIZE;
  return { limit, offset: (page - 1) * limit, page };
}

// ══════════════════════════════════════════════════════
// GET /contents?wing=kids&category=phonics&page=1&limit=3
// Wing-isolated content list — Kids Wing only ever sees wing_type='kids'
// rows, no cross-wing leakage. Public, no login required.
// ══════════════════════════════════════════════════════
router.get('/contents', async (req, res) => {
  try {
    const { wing, category } = req.query;
    if (!wing) return res.status(400).json({ error: 'wing_required' });
    const { limit, offset, page } = parsePage(req);

    const cacheKey = `contents:${wing}:${category || ''}:${page}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const params = [wing];
    let sql = `
      SELECT id, wing_type, category_key, content_kind, title, body, thumbnail_url, media_url,
             like_count, view_count, published_at
      FROM contents
      WHERE is_published = TRUE AND wing_type = $1`; // ← data isolation: hard-scoped to this wing, always
    if (category) { params.push(category); sql += ` AND category_key = $${params.length}`; }
    params.push(limit, offset);
    sql += ` ORDER BY published_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await pool.query(sql, params);
    const payload = { success: true, wing, page, page_size: limit, count: rows.length, data: rows };
    cache.set(cacheKey, payload, 30_000); // 30s TTL — short enough that new posts show up fast
    res.json(payload);
  } catch (err) {
    console.error('[feed/contents] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ══════════════════════════════════════════════════════
// GET /feed?page=1
// Personalized "Facebook-style" home feed. Works logged-out too (falls
// back to a pure recency+engagement ranking with no personalization
// terms) — optionalAuth, not requireAuth.
// ══════════════════════════════════════════════════════
router.get('/feed', optionalAuth, async (req, res) => {
  try {
    const { limit, offset, page } = parsePage(req);
    const userId = req.user ? req.user.id : null;

    const cacheKey = `feed:${userId || 'anon'}:${page}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    // Relevance score — aligned to your doc's formula: wing match (×5.0)
    // + category match (×3.0) + linear recency decay over 5 days. No
    // engagement term in this version (your spec doesn't score by
    // likes/views) — see routes/feed.js's module comment if you want that
    // back in later.
    // COALESCE($1::int, 0) lets this run for anonymous users too — the
    // LEFT JOIN then finds no user row, interests/preferred_wings fall
    // back to '{}', and those two score terms simply contribute 0.
    const sql = `
      WITH me AS (SELECT COALESCE($1::int, 0) AS uid),
      my_prefs AS (
        SELECT COALESCE(u.interests, '{}') AS interests,
               COALESCE(u.preferred_wings, '{}') AS preferred_wings
        FROM me LEFT JOIN users u ON u.id = me.uid
      )
      SELECT
        c.id, c.wing_type, c.category_key, c.content_kind, c.title, c.body,
        c.thumbnail_url, c.media_url, c.like_count, c.view_count, c.published_at,
        (
          -- ১. উইং পছন্দ (multiplier: 5.0)
          (CASE WHEN c.wing_type = ANY(p.preferred_wings) THEN 5.0 ELSE 0.0 END)
          -- ২. ক্যাটাগরি পছন্দ (multiplier: 3.0)
          + (CASE WHEN c.category_key = ANY(p.interests) THEN 3.0 ELSE 0.0 END)
          -- ৩. কন্টেন্টের নতুনত্ব (Recency boost: decays linearly over 5 days)
          + GREATEST(0, 5.0 - (EXTRACT(EPOCH FROM (now() - c.published_at)) / 86400.0))
        )::numeric(10,2) AS relevance_score
      FROM contents c, my_prefs p
      WHERE c.is_published = TRUE
      ORDER BY relevance_score DESC, c.published_at DESC
      LIMIT $2 OFFSET $3`;

    const { rows } = await pool.query(sql, [userId, limit, offset]);
    const payload = { success: true, page, page_size: limit, count: rows.length, personalized: !!userId, data: rows };
    cache.set(cacheKey, payload, 20_000); // shorter TTL than /contents — feed should feel "live"
    res.json(payload);
  } catch (err) {
    console.error('[feed/feed] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ══════════════════════════════════════════════════════
// POST /contents/:id/view — log a view (idempotent per user+content)
// ══════════════════════════════════════════════════════
router.post('/contents/:id/view', optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ ok: true, skipped: 'anonymous' }); // don't error — just don't track anonymous views per-user
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO user_activities (user_id, content_id, activity_type)
       VALUES ($1,$2,'view') ON CONFLICT DO NOTHING RETURNING id`,
      [req.user.id, req.params.id]
    );
    if (inserted.rowCount > 0) {
      await client.query(`UPDATE contents SET view_count = view_count + 1 WHERE id = $1`, [req.params.id]);
      cache.invalidatePrefix('feed:'); // views affect ranking — drop cached feed pages
      cache.invalidatePrefix('contents:'); // and the raw listing's cached like/view counts
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[feed/view] error:', err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════
// POST /contents/:id/like  and  DELETE /contents/:id/like — toggle
// ══════════════════════════════════════════════════════
router.post('/contents/:id/like', requireAuth(), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO user_activities (user_id, content_id, activity_type)
       VALUES ($1,$2,'like') ON CONFLICT DO NOTHING RETURNING id`,
      [req.user.id, req.params.id]
    );
    if (inserted.rowCount > 0) {
      await client.query(`UPDATE contents SET like_count = like_count + 1 WHERE id = $1`, [req.params.id]);
      cache.invalidatePrefix('feed:');
      cache.invalidatePrefix('contents:');
    }
    await client.query('COMMIT');
    res.json({ ok: true, liked: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[feed/like] error:', err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

router.delete('/contents/:id/like', requireAuth(), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      `DELETE FROM user_activities WHERE user_id=$1 AND content_id=$2 AND activity_type='like' RETURNING id`,
      [req.user.id, req.params.id]
    );
    if (deleted.rowCount > 0) {
      await client.query(`UPDATE contents SET like_count = GREATEST(0, like_count - 1) WHERE id = $1`, [req.params.id]);
      cache.invalidatePrefix('feed:');
      cache.invalidatePrefix('contents:');
    }
    await client.query('COMMIT');
    res.json({ ok: true, liked: false });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[feed/unlike] error:', err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════
// GET /recommendations?wings=kids,news&interests=bcs,physics
// Public. Returns a handful of approved courses + active mart/book
// products to push in the Feed — "relevant courses, books, or
// instruments" per the person's checked interests. Falls back to
// newest/highest-rated when no wings/interests are given (e.g. an
// anonymous visitor).
// ══════════════════════════════════════════════════════
router.get('/recommendations', async (req, res) => {
  try {
    const wings = (req.query.wings || '').split(',').map(s=>s.trim()).filter(Boolean);
    const interests = (req.query.interests || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);

    const cacheKey = `recs:${wings.join('|')}:${interests.join('|')}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    // Courses: prefer ones whose category matches an interest tag; a
    // course has no `wing` column (courses are always the Academy wing),
    // so wings only affects whether we bother querying at all.
    const courseParams = [];
    let courseSql = `SELECT id, title, category, price, rating, ai_quality_score
                      FROM courses WHERE status = 'approved'`;
    if (interests.length) {
      courseParams.push(interests);
      courseSql += ` AND lower(category) = ANY($${courseParams.length})`;
    }
    courseSql += ` ORDER BY rating DESC NULLS LAST, submitted_at DESC LIMIT 3`;

    // Products: books (Publications wing) and mart items — same idea,
    // category match first, else newest.
    const productParams = [];
    let productSql = `SELECT id, type, title, category, price, stock
                       FROM products WHERE status = 'active'`;
    if (interests.length) {
      productParams.push(interests);
      productSql += ` AND lower(category) = ANY($${productParams.length})`;
    }
    productSql += ` ORDER BY created_at DESC LIMIT 3`;

    const [courses, products] = await Promise.all([
      pool.query(courseSql, courseParams),
      pool.query(productSql, productParams)
    ]);

    const payload = {
      success: true,
      courses: courses.rows,
      products: products.rows
    };
    cache.set(cacheKey, payload, 60_000);
    res.json(payload);
  } catch (err) {
    console.error('[feed/recommendations] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ══════════════════════════════════════════════════════
// POST /contents — any logged-in user creates a post in a wing of their
// choice. This is what turns the Feed composer into a real cross-wing
// "post to Academy / Kids / Community / anywhere" feature — distinct from
// admin's /admin/contents (which is for official/curated publishing and
// has no rate limit or ownership check). User posts here are always
// content_kind='post', capped, and tied to author_id so they can be
// identified/removed later if needed.
// ══════════════════════════════════════════════════════
const USER_POST_RATE = { windowMs: 60 * 60 * 1000, max: 20 }; // 20 posts/hour/user
const userPostHits = new Map();
function isUserPostRateLimited(userId) {
  const now = Date.now();
  const arr = (userPostHits.get(userId) || []).filter(t => now - t < USER_POST_RATE.windowMs);
  arr.push(now);
  userPostHits.set(userId, arr);
  return arr.length > USER_POST_RATE.max;
}

router.post('/contents', requireAuth(), async (req, res) => {
  if (isUserPostRateLimited(req.user.id)) {
    return res.status(429).json({ error: 'rate_limited', message: 'অনেকবার পোস্ট করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন' });
  }
  const { wing_type, title, body } = req.body || {};
  if (!wing_type || !title) return res.status(400).json({ error: 'wing_type_and_title_required' });
  if (String(title).length > 300) return res.status(400).json({ error: 'title_too_long' });
  if (body && String(body).length > 8000) return res.status(400).json({ error: 'body_too_long' });

  try {
    const wingExists = await pool.query(`SELECT 1 FROM wings WHERE wing_key = $1`, [wing_type]);
    if (!wingExists.rowCount) return res.status(400).json({ error: 'unknown_wing_type' });

    const { rows } = await pool.query(
      `INSERT INTO contents (wing_type, category_key, content_kind, title, body, author_id)
       VALUES ($1,'community-post','post',$2,$3,$4)
       RETURNING id, title, wing_type, published_at`,
      [wing_type, String(title).slice(0, 300), body ? String(body).slice(0, 8000) : null, req.user.id]
    );
    cache.invalidatePrefix('feed:');
    cache.invalidatePrefix('contents:');
    res.status(201).json({ ok: true, content: rows[0] });
  } catch (err) {
    console.error('[feed/contents POST] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
