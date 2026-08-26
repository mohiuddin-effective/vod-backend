const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * requireAuth(...roles)
 * - With no args: just requires a valid token, attaches req.user.
 * - With role names: also requires req.user.role to be one of them.
 *   e.g. requireAuth('admin')  or  requireAuth('admin','teacher')
 */
function requireAuth(...roles) {
  return (req, res, next) => {
    if (!JWT_SECRET) {
      // Fail closed, not open — a missing secret must never mean "let everyone in".
      console.error('[auth] JWT_SECRET is not set in the environment.');
      return res.status(500).json({ error: 'server_misconfigured' });
    }

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing_token' });

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ error: 'forbidden', required_role: roles });
      }
      req.user = payload; // { id, email, role }
      next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid_or_expired_token' });
    }
  };
}

module.exports = { requireAuth };

/**
 * optionalAuth
 * - Attaches req.user if a valid token is present.
 * - Never rejects the request — an absent or invalid token just means
 *   req.user stays undefined. For routes that personalize when logged in
 *   but still work (with generic/trending results) for anonymous visitors,
 *   e.g. GET /feed.
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); }
    catch (err) { /* invalid/expired token — proceed as anonymous, don't error */ }
  }
  next();
}
module.exports.optionalAuth = optionalAuth;
