const express = require('express');
const pool = require('../db/pool');
const cache = require('../lib/cache');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ══════════════════════════════════════════════════════
// Public browsing — Academy courses, Publications books, Mart items.
// Nothing on the site could previously show a real course/product catalog
// to a visitor; these fill that gap.
// ══════════════════════════════════════════════════════

// GET /academy/courses?category=&page=1
router.get('/academy/courses', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20, offset = (page - 1) * limit;
    const cacheKey = `courses:${req.query.category || ''}:${page}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const params = [];
    let sql = `SELECT c.id, c.title, c.category, c.price, c.rating, c.ai_quality_score, u.name AS teacher_name
               FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
               WHERE c.status = 'approved'`;
    if (req.query.category) { params.push(req.query.category); sql += ` AND c.category = $${params.length}`; }
    params.push(limit, offset);
    sql += ` ORDER BY c.rating DESC NULLS LAST, c.submitted_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await pool.query(sql, params);
    const payload = { success: true, page, count: rows.length, courses: rows };
    cache.set(cacheKey, payload, 30_000);
    res.json(payload);
  } catch (err) {
    console.error('[academy/courses] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /academy/courses/:id
router.get('/academy/courses/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.category, c.price, c.rating, c.ai_quality_score, c.status,
              u.name AS teacher_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS student_count
       FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
       WHERE c.id = $1 AND c.status = 'approved'`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'course_not_found' });
    res.json({ success: true, course: rows[0] });
  } catch (err) {
    console.error('[academy/courses/:id] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /publications/books  and  GET /mart/products  — same products table, different `type`
function productBrowseHandler(type) {
  return async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = 20, offset = (page - 1) * limit;
      const cacheKey = `products:${type}:${req.query.category || ''}:${page}`;
      const cached = cache.get(cacheKey);
      if (cached) return res.json({ ...cached, cached: true });

      const params = [type];
      let sql = `SELECT id, title, category, price, stock, rating FROM products WHERE type = $1 AND status = 'active'`;
      if (req.query.category) { params.push(req.query.category); sql += ` AND category = $${params.length}`; }
      params.push(limit, offset);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

      const { rows } = await pool.query(sql, params);
      const payload = { success: true, page, count: rows.length, products: rows };
      cache.set(cacheKey, payload, 30_000);
      res.json(payload);
    } catch (err) {
      console.error(`[${type}/products] error:`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  };
}
router.get('/publications/books', productBrowseHandler('book'));
router.get('/mart/products', productBrowseHandler('mart'));

// ══════════════════════════════════════════════════════
// Enroll / purchase — the actual missing piece. Both wrapped in a
// transaction: one write creates the order, the other records what it
// was for (enrollment, or stock decrement), and both succeed or neither
// does — no half-completed "paid but not enrolled" states.
// ══════════════════════════════════════════════════════

// POST /academy/courses/:id/enroll
router.post('/academy/courses/:id/enroll', requireAuth(), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const courseRes = await client.query(
      `SELECT id, title, price FROM courses WHERE id = $1 AND status = 'approved' FOR UPDATE`,
      [req.params.id]
    );
    const course = courseRes.rows[0];
    if (!course) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'course_not_found' }); }

    const existing = await client.query(
      `SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2`,
      [req.user.id, course.id]
    );
    if (existing.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_enrolled' }); }

    await client.query(
      `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)`,
      [req.user.id, course.id]
    );
    const orderRes = await client.query(
      `INSERT INTO orders (user_id, source, course_id, amount) VALUES ($1,'course',$2,$3) RETURNING id`,
      [req.user.id, course.id, course.price]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, enrolled: true, course_title: course.title, order_id: orderRes.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[academy/enroll] error:', err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// POST /products/:id/buy  { quantity }
router.post('/products/:id/buy', requireAuth(), async (req, res) => {
  const rawQty = req.body?.quantity;
  const quantity = parseInt(rawQty, 10) || 1;
  // Reject out-of-range quantities outright rather than silently
  // substituting a different number — a client that asked for 9999 and
  // got charged for 20 with no warning would have no way to notice.
  if (quantity < 1 || quantity > 50) {
    return res.status(400).json({ error: 'invalid_quantity', message: 'পরিমাণ ১ থেকে ৫০-এর মধ্যে হতে হবে' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productRes = await client.query(
      `SELECT id, title, price, stock, type FROM products WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [req.params.id]
    );
    const product = productRes.rows[0];
    if (!product) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'product_not_found' }); }
    if (product.stock < quantity) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'insufficient_stock', available: product.stock }); }

    const newStock = product.stock - quantity;
    await client.query(
      `UPDATE products SET stock = $1, status = CASE WHEN $1 = 0 THEN 'out_of_stock' ELSE status END WHERE id = $2`,
      [newStock, product.id]
    );
    const amount = Number(product.price) * quantity;
    const orderRes = await client.query(
      `INSERT INTO orders (user_id, source, product_id, amount) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.user.id, product.type === 'book' ? 'book' : 'mart', product.id, amount]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, product_title: product.title, quantity, amount, order_id: orderRes.rows[0].id, remaining_stock: newStock });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[products/buy] error:', err);
    res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// GET /me/enrollments and /me/orders — "my courses" / "my purchases"
router.get('/me/enrollments', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.category, e.enrolled_at
       FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.user_id = $1 ORDER BY e.enrolled_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, enrollments: rows });
  } catch (err) {
    console.error('[me/enrollments] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/me/orders', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.source, o.amount, o.created_at,
              c.title AS course_title, p.title AS product_title
       FROM orders o
       LEFT JOIN courses c ON c.id = o.course_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.user_id = $1 ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, orders: rows });
  } catch (err) {
    console.error('[me/orders] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
