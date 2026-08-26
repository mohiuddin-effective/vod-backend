const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth('teacher'));

// ── GET /teacher/overview — replaces the hardcoded metric-row on the Teacher Dashboard ──
router.get('/overview', async (req, res) => {
  const teacherId = req.user.id;
  try {
    const [earnings, students, courseCount, avgRating, recentSales] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(o.amount),0) AS total FROM orders o
         JOIN courses c ON c.id = o.course_id
         WHERE c.teacher_id = $1 AND o.created_at >= date_trunc('month', now())`, [teacherId]),
      pool.query(
        `SELECT COUNT(DISTINCT e.user_id) AS total FROM enrollments e
         JOIN courses c ON c.id = e.course_id WHERE c.teacher_id = $1`, [teacherId]),
      pool.query(`SELECT COUNT(*) AS total FROM courses WHERE teacher_id = $1 AND status = 'approved'`, [teacherId]),
      pool.query(`SELECT COALESCE(AVG(rating),0) AS avg FROM courses WHERE teacher_id = $1 AND rating IS NOT NULL`, [teacherId]),
      pool.query(
        `SELECT o.amount, o.created_at, c.title FROM orders o
         JOIN courses c ON c.id = o.course_id
         WHERE c.teacher_id = $1 ORDER BY o.created_at DESC LIMIT 5`, [teacherId])
    ]);

    res.json({
      monthly_earnings: Number(earnings.rows[0].total),
      total_students: Number(students.rows[0].total),
      published_courses: Number(courseCount.rows[0].total),
      avg_rating: Number(avgRating.rows[0].avg).toFixed(1),
      recent_sales: recentSales.rows
    });
  } catch (err) {
    console.error('[teacher/overview] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /teacher/courses — replaces the hardcoded course table ──
router.get('/courses', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.status, c.ai_quality_score, c.rating, c.price,
              (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS student_count,
              (SELECT COALESCE(SUM(o.amount),0) FROM orders o WHERE o.course_id = c.id) AS total_earnings
       FROM courses c
       WHERE c.teacher_id = $1
       ORDER BY c.submitted_at DESC`,
      [req.user.id]
    );
    res.json({ courses: rows });
  } catch (err) {
    console.error('[teacher/courses] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /teacher/courses — submit a new course (goes into the admin approval queue) ──
router.post('/courses', async (req, res) => {
  const { title, category, price } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title_required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO courses (title, teacher_id, category, price, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING id, title, status`,
      [title, req.user.id, category || null, price || 0]
    );
    res.status(201).json({ ok: true, course: rows[0] });
  } catch (err) {
    console.error('[teacher/courses POST] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
