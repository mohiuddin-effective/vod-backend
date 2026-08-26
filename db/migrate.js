require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[migrate] applying schema.sql ...');
  await pool.query(sql);
  console.log('[migrate] done. Tables ready: users, courses, enrollments, orders, payouts, activity_log');
  await pool.end();
}

migrate().catch(err => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
