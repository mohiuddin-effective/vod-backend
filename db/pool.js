const { Pool } = require('pg');

// Render Postgres (and most managed Postgres hosts) require SSL.
// DATABASE_URL is provided automatically by Render when you attach a Postgres
// instance to this service — see README.md for setup steps.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle Postgres client', err);
});

module.exports = pool;
