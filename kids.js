const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// All routes here are PUBLIC (no login) — kids content is meant to be
// freely browsable. Admin-only write routes can be added later the same
// way routes/admin.js does it (requireAuth('admin')).

// GET /kids/categories
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, category_key, title_bn, title_en, title_ar, icon_symbol, display_order
       FROM kids_categories ORDER BY display_order ASC, id ASC`
    );
    res.json({ categories: rows });
  } catch (err) {
    console.error('[kids/categories] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /kids/modules?lang=bn&category=phonics&access=free
router.get('/modules', async (req, res) => {
  try {
    const { lang = 'bn', category, access } = req.query;
    if (!['bn', 'en', 'ar'].includes(lang)) return res.status(400).json({ error: 'invalid_lang' });

    const params = [lang];
    let sql = `
      SELECT m.id AS module_id, m.title, m.description, m.language, m.thumbnail_url,
             m.access_level, m.min_age, m.max_age,
             c.category_key, c.title_bn AS cat_bn, c.title_en AS cat_en, c.title_ar AS cat_ar, c.icon_symbol
      FROM kids_modules m
      JOIN kids_categories c ON m.category_id = c.id
      WHERE m.is_active = TRUE AND m.language = $1`;

    if (category) { params.push(category); sql += ` AND c.category_key = $${params.length}`; }
    if (access && ['free', 'premium'].includes(access)) { params.push(access); sql += ` AND m.access_level = $${params.length}`; }
    sql += ` ORDER BY c.display_order ASC, m.id ASC`;

    const { rows } = await pool.query(sql, params);
    res.json({ success: true, count: rows.length, language: lang, data: rows });
  } catch (err) {
    console.error('[kids/modules] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /kids/modules/:id/contents
router.get('/modules/:id/contents', async (req, res) => {
  try {
    const moduleRes = await pool.query(
      `SELECT * FROM kids_modules WHERE id = $1 AND is_active = TRUE`, [req.params.id]
    );
    if (!moduleRes.rows[0]) return res.status(404).json({ error: 'module_not_found' });

    const contentsRes = await pool.query(
      `SELECT id, content_title, content_type, media_url, audio_pronunciation_url, game_payload, sequence_order
       FROM kids_contents WHERE module_id = $1 ORDER BY sequence_order ASC`,
      [req.params.id]
    );
    res.json({ success: true, module: moduleRes.rows[0], contents: contentsRes.rows });
  } catch (err) {
    console.error('[kids/modules/:id/contents] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
