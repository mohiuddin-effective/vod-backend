const express = require('express');
const pool = require('../db/pool');
const cache = require('../lib/cache');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Every route in this file requires a valid admin JWT.
router.use(requireAuth('admin'));

async function logActivity(actorId, action, targetType, targetId) {
  try {
    await pool.query(
      'INSERT INTO activity_log (actor_id, action, target_type, target_id) VALUES ($1,$2,$3,$4)',
      [actorId, action, targetType, String(targetId)]
    );
  } catch (err) {
    console.error('[admin] failed to log activity:', err);
  }
}

// ── GET /admin/overview — replaces the hardcoded metric-row + activity feed ──
router.get('/overview', async (req, res) => {
  try {
    const [revenue, users, courses, aiAvg, activity] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM orders WHERE created_at >= date_trunc('month', now())`),
      pool.query(`SELECT COUNT(*) AS total FROM users`),
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='pending') AS pending FROM courses`),
      pool.query(`SELECT COALESCE(AVG(ai_quality_score),0) AS avg FROM courses WHERE ai_quality_score IS NOT NULL`),
      pool.query(`SELECT action, target_type, target_id, created_at FROM activity_log ORDER BY created_at DESC LIMIT 10`)
    ]);

    res.json({
      monthly_revenue: Number(revenue.rows[0].total),
      total_users: Number(users.rows[0].total),
      total_courses: Number(courses.rows[0].total),
      pending_courses: Number(courses.rows[0].pending),
      ai_quality_avg: Math.round(Number(aiAvg.rows[0].avg)),
      recent_activity: activity.rows
    });
  } catch (err) {
    console.error('[admin/overview] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Course approval queue ──────────────────────────────────────────────
router.get('/courses/pending', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.category, c.ai_quality_score, c.submitted_at, u.name AS teacher_name
       FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
       WHERE c.status = 'pending' ORDER BY c.submitted_at ASC`
    );
    res.json({ courses: rows });
  } catch (err) {
    console.error('[admin/courses/pending] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/courses/:id/approve', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE courses SET status='approved', reviewed_at=now() WHERE id=$1 RETURNING id, title`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'course_not_found' });
    await logActivity(req.user.id, 'course_approved', 'course', req.params.id);
    res.json({ ok: true, course: rows[0] });
  } catch (err) {
    console.error('[admin/courses/approve] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/courses/:id/reject', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE courses SET status='rejected', reviewed_at=now() WHERE id=$1 RETURNING id, title`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'course_not_found' });
    await logActivity(req.user.id, 'course_rejected', 'course', req.params.id);
    res.json({ ok: true, course: rows[0] });
  } catch (err) {
    console.error('[admin/courses/reject] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Teacher verification queue ─────────────────────────────────────────
router.get('/teachers/pending', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, nid_verified, bank_verified, created_at
       FROM users WHERE role='teacher' AND is_verified = FALSE ORDER BY created_at ASC`
    );
    res.json({ teachers: rows });
  } catch (err) {
    console.error('[admin/teachers/pending] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/teachers/:id/verify', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_verified=TRUE WHERE id=$1 AND role='teacher' RETURNING id, name`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'teacher_not_found' });
    await logActivity(req.user.id, 'teacher_verified', 'user', req.params.id);
    res.json({ ok: true, teacher: rows[0] });
  } catch (err) {
    console.error('[admin/teachers/verify] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Payouts ──────────────────────────────────────────────────────────
router.get('/payouts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, u.name AS teacher_name, p.total_sales, p.platform_cut_pct,
              ROUND(p.total_sales * p.platform_cut_pct / 100, 2) AS platform_cut,
              ROUND(p.total_sales * (100 - p.platform_cut_pct) / 100, 2) AS teacher_share,
              p.status, p.period_label, p.paid_at
       FROM payouts p JOIN users u ON u.id = p.teacher_id
       ORDER BY p.created_at DESC`
    );
    res.json({ payouts: rows });
  } catch (err) {
    console.error('[admin/payouts] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/payouts/:id/pay', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE payouts SET status='paid', paid_at=now() WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'payout_not_found' });
    await logActivity(req.user.id, 'payout_paid', 'payout', req.params.id);
    res.json({ ok: true, payout_id: rows[0].id });
  } catch (err) {
    console.error('[admin/payouts/pay] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/payouts/pay-all', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE payouts SET status='paid', paid_at=now() WHERE status='pending' RETURNING id`
    );
    await logActivity(req.user.id, 'payout_pay_all', 'payout', rows.length);
    res.json({ ok: true, paid_count: rows.length });
  } catch (err) {
    console.error('[admin/payouts/pay-all] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Reports ──────────────────────────────────────────────────────────
router.get('/report', async (req, res) => {
  try {
    const [bySource, totals] = await Promise.all([
      pool.query(`SELECT source, COALESCE(SUM(amount),0) AS total FROM orders GROUP BY source`),
      pool.query(`SELECT
          (SELECT COUNT(*) FROM orders WHERE source='book') AS book_orders,
          (SELECT COUNT(*) FROM enrollments) AS course_enrollments,
          (SELECT COUNT(*) FROM orders WHERE source='mart') AS mart_orders
      `)
    ]);
    const bySourceMap = Object.fromEntries(bySource.rows.map(r => [r.source, Number(r.total)]));
    const grandTotal = Object.values(bySourceMap).reduce((a, b) => a + b, 0) || 1;
    const breakdown = Object.entries(bySourceMap).map(([source, total]) => ({
      source, total, pct: Math.round((total / grandTotal) * 100)
    }));
    res.json({ revenue_breakdown: breakdown, ...totals.rows[0] });
  } catch (err) {
    console.error('[admin/report] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Feed content management (publish to the /feed multi-wing feed) ────
router.get('/contents', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20, offset = (page - 1) * limit;
    const [rows, wings] = await Promise.all([
      pool.query(
        `SELECT id, wing_type, category_key, content_kind, title, tags,
                like_count, view_count, is_published, published_at
         FROM contents ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT wing_key, title_bn, title_en, icon_symbol FROM wings ORDER BY display_order`)
    ]);
    res.json({ contents: rows.rows, wings: wings.rows, page });
  } catch (err) {
    console.error('[admin/contents] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/contents', async (req, res) => {
  const { wing_type, category_key, content_kind, title, body, media_url, thumbnail_url, tags } = req.body || {};
  if (!wing_type || !category_key || !title) {
    return res.status(400).json({ error: 'wing_type_category_key_title_required' });
  }
  const validKinds = ['video', 'game', 'article', 'post', 'audio', 'worksheet'];
  const kind = validKinds.includes(content_kind) ? content_kind : 'article';
  const cleanTags = Array.isArray(tags)
    ? tags.map(t => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 20)
    : [];
  try {
    // wing_type must reference an existing row in `wings` (FK) — a clear
    // 400 here is much friendlier than the raw FK-violation 500 otherwise.
    const wingExists = await pool.query(`SELECT 1 FROM wings WHERE wing_key = $1`, [wing_type]);
    if (!wingExists.rowCount) return res.status(400).json({ error: 'unknown_wing_type' });

    const { rows } = await pool.query(
      `INSERT INTO contents (wing_type, category_key, content_kind, title, body, media_url, thumbnail_url, tags, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, title, wing_type, is_published, published_at`,
      [wing_type, category_key, kind, title, body || null, media_url || null, thumbnail_url || null, cleanTags, req.user.id]
    );
    cache.invalidatePrefix('feed:');
    cache.invalidatePrefix('contents:');
    await logActivity(req.user.id, 'content_published', 'content', rows[0].id);
    res.status(201).json({ ok: true, content: rows[0] });
  } catch (err) {
    console.error('[admin/contents POST] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/contents/:id', async (req, res) => {
  const { is_published, title, body } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE contents SET
         is_published = COALESCE($1, is_published),
         title = COALESCE($2, title),
         body = COALESCE($3, body)
       WHERE id = $4
       RETURNING id, title, is_published`,
      [is_published ?? null, title ?? null, body ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'content_not_found' });
    cache.invalidatePrefix('feed:');
    cache.invalidatePrefix('contents:');
    res.json({ ok: true, content: rows[0] });
  } catch (err) {
    console.error('[admin/contents PATCH] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.delete('/contents/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM contents WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'content_not_found' });
    cache.invalidatePrefix('feed:');
    cache.invalidatePrefix('contents:');
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/contents DELETE] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
