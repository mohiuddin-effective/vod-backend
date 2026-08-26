const express = require('express');
const pool = require('../db/pool');
const cache = require('../lib/cache');
const { optionalAuth, requireAuth } = require('../middleware/auth');

const router = express.Router();

const PAGE_SIZE = 10; // "১০টি করে কন্টেন্ট" — matches the requested IntersectionObserver page size

function parsePage(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, page };
}

// ══════════════════════════════════════════════════════
// GET /contents?wing=kids&category=phonics&page=1
// Wing-isolated content list — Kids Wing only ever sees wing_type='kids'
// rows, no cross-wing leakage. Public, no login required.
// ══════════════════════════════════════════════════════
router.get('/contents', async (req, res) => {
  try {
    const { wing, category } = req.query;
    if (!wing) return res.status(400).json({ error: 'wing_required' });
    const { limit, offset, page } = parsePage(req);

    const cacheKey = `contents:${wing}:${category || ''}:${page}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const params = [wing];
    let sql = `
      SELECT id, wing_type, category_key, content_kind, title, thumbnail_url, media_url,
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

    // Relevance score = interest-tag overlap + preferred-wing match
    //                  + recency decay + log-dampened engagement.
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
        c.id, c.wing_type, c.category_key, c.content_kind, c.title,
        c.thumbnail_url, c.media_url, c.like_count, c.view_count, c.published_at,
        (
          -- 1) ইউজারের ইন্টারেস্ট ট্যাগের সাথে মিল — প্রতিটি মিলে ১৫ পয়েন্ট
          (SELECT count(*) FROM unnest(c.tags) t WHERE t = ANY(p.interests)) * 15
          -- 2) পছন্দের উইং হলে ফ্ল্যাট ২০ পয়েন্ট বোনাস
          + (CASE WHEN c.wing_type = ANY(p.preferred_wings) THEN 20 ELSE 0 END)
          -- 3) Recency boost — exponential time decay, ~48h হাফ-লাইফ, নতুন কন্টেন্ট উপরে থাকবে
          + 30 * exp(-EXTRACT(EPOCH FROM (now() - c.published_at)) / 172800.0)
          -- 4) Engagement — log-dampened যাতে একটামাত্র viral পোস্ট পুরো ফিড দখল না করে
          + ln(1 + c.like_count * 3 + c.view_count)
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

module.exports = router;
