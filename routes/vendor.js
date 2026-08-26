const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// Publisher (books) and Seller (mart items) are the same shape of dashboard —
// "my products, my orders, my revenue" — so one factory builds both routers.
// mount as: app.use('/publisher', vendorRouter('publisher', 'book'))
//           app.use('/seller', vendorRouter('seller', 'mart'))
function vendorRouter(role, productType) {
  const router = express.Router();
  router.use(requireAuth(role));

  router.get('/overview', async (req, res) => {
    const ownerId = req.user.id;
    try {
      const [revenue, orderCount, productCount, recent] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(o.amount),0) AS total FROM orders o
           JOIN products p ON p.id = o.product_id
           WHERE p.owner_id = $1 AND o.created_at >= date_trunc('month', now())`, [ownerId]),
        pool.query(
          `SELECT COUNT(*) AS total FROM orders o
           JOIN products p ON p.id = o.product_id WHERE p.owner_id = $1`, [ownerId]),
        pool.query(`SELECT COUNT(*) AS total FROM products WHERE owner_id = $1 AND status='active'`, [ownerId]),
        pool.query(
          `SELECT o.amount, o.created_at, p.title FROM orders o
           JOIN products p ON p.id = o.product_id
           WHERE p.owner_id = $1 ORDER BY o.created_at DESC LIMIT 5`, [ownerId])
      ]);
      res.json({
        monthly_revenue: Number(revenue.rows[0].total),
        total_orders: Number(orderCount.rows[0].total),
        active_products: Number(productCount.rows[0].total),
        recent_orders: recent.rows
      });
    } catch (err) {
      console.error(`[${role}/overview] error:`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.get('/products', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.title, p.category, p.price, p.stock, p.status, p.rating,
                COUNT(o.id) AS order_count, COALESCE(SUM(o.amount),0) AS total_earnings
         FROM products p
         LEFT JOIN orders o ON o.product_id = p.id
         WHERE p.owner_id = $1 AND p.type = $2
         GROUP BY p.id ORDER BY p.created_at DESC`,
        [req.user.id, productType]
      );
      res.json({ products: rows });
    } catch (err) {
      console.error(`[${role}/products] error:`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/products', async (req, res) => {
    const { title, category, price, stock } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title_required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO products (owner_id, type, title, category, price, stock, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id, title, status`,
        [req.user.id, productType, title, category || null, price || 0, stock || 0]
      );
      res.status(201).json({ ok: true, product: rows[0] });
    } catch (err) {
      console.error(`[${role}/products POST] error:`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.put('/products/:id', async (req, res) => {
    const { price, stock, status } = req.body || {};
    try {
      const { rows } = await pool.query(
        `UPDATE products SET
           price = COALESCE($1, price),
           stock = COALESCE($2, stock),
           status = COALESCE($3, status)
         WHERE id = $4 AND owner_id = $5 AND type = $6
         RETURNING id, title, price, stock, status`,
        [price ?? null, stock ?? null, status ?? null, req.params.id, req.user.id, productType]
      );
      if (!rows[0]) return res.status(404).json({ error: 'product_not_found' });
      res.json({ ok: true, product: rows[0] });
    } catch (err) {
      console.error(`[${role}/products PUT] error:`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

module.exports = vendorRouter;
