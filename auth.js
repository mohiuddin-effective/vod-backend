const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '12h';

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// POST /auth/login  { email, password } — `email` may also be a phone number
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
  if (!JWT_SECRET) return res.status(500).json({ error: 'server_misconfigured' });

  try {
    const identifier = String(email).trim();
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR phone = $1',
      [identifier.includes('@') ? identifier.toLowerCase() : identifier]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    res.json({
      ok: true,
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role }
    });
  } catch (err) {
    console.error('[auth/login] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /auth/register  { name, email, password, role }
// role is restricted to self-serve roles; admins are only created via db/seed.js
router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const allowedRoles = ['student', 'teacher', 'publisher', 'seller'];
  if (!name || !email || !password) return res.status(400).json({ error: 'name_email_password_required' });
  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'invalid_role' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1,$2,$3,$4) RETURNING id, name, email, role`,
      [name, email.toLowerCase(), hash, role]
    );
    res.status(201).json({ ok: true, user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_already_registered' });
    console.error('[auth/register] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /auth/quick-register  { name, email?, phone? }
// The "first visit → sign up with just a name + phone/email" flow — no
// password step. A random password is generated and hashed server-side
// (never shown to the client) purely so the row fits the same schema as
// every other login; the person is logged straight in via the returned
// token, exactly like the full /register + /login combined into one call.
// Always creates role='student' — that's the only role this flow is for.
router.post('/quick-register', async (req, res) => {
  const { name, email, phone } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name_required' });
  if (!email && !phone) return res.status(400).json({ error: 'email_or_phone_required' });
  if (!JWT_SECRET) return res.status(500).json({ error: 'server_misconfigured' });

  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  const cleanPhone = phone ? String(phone).trim() : null;

  try {
    const randomPassword = crypto.randomBytes(24).toString('hex');
    const hash = await bcrypt.hash(randomPassword, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role)
       VALUES ($1,$2,$3,$4,'student')
       RETURNING id, name, email, phone, role`,
      [String(name).trim(), cleanEmail, cleanPhone, hash]
    );
    const user = rows[0];
    res.status(201).json({ ok: true, token: signToken(user), user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'already_registered' });
    console.error('[auth/quick-register] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /auth/me — current user's profile + feed personalization prefs
router.get('/me', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, role, interests, preferred_wings FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[auth/me] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /auth/me/preferences  { interests: string[], preferred_wings: string[] }
// Powers the Feed page's "আমার আগ্রহ" panel — these two arrays are exactly
// what routes/feed.js's /feed relevance-score query reads for this user.
router.put('/me/preferences', requireAuth(), async (req, res) => {
  const { interests, preferred_wings } = req.body || {};
  if (interests && !Array.isArray(interests)) return res.status(400).json({ error: 'interests_must_be_array' });
  if (preferred_wings && !Array.isArray(preferred_wings)) return res.status(400).json({ error: 'preferred_wings_must_be_array' });

  // Keep each tag short and sane — this is free text a user controls, and
  // it flows straight into a tsvector-free array comparison, so cap length
  // rather than trust the client.
  const clean = arr => (arr || []).map(s => String(s).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 20);

  try {
    const { rows } = await pool.query(
      `UPDATE users SET
         interests = COALESCE($1, interests),
         preferred_wings = COALESCE($2, preferred_wings)
       WHERE id = $3
       RETURNING id, name, email, role, interests, preferred_wings`,
      [interests ? clean(interests) : null, preferred_wings ? clean(preferred_wings) : null, req.user.id]
    );
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    console.error('[auth/me/preferences] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
