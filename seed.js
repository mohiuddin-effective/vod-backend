require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

// The first admin account is created from environment variables so no real
// password ever lives in source control. Set ADMIN_EMAIL / ADMIN_PASSWORD
// in your .env (or Render env vars) before running `npm run seed`.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@effectiveeducationhub.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

async function seed() {
  if (!ADMIN_PASSWORD) {
    console.error('[seed] Set ADMIN_PASSWORD in your environment before seeding. Aborting.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Admin user (idempotent)
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const adminRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role, is_verified)
       VALUES ($1,$2,$3,'admin',TRUE)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      ['Admin', ADMIN_EMAIL, adminHash]
    );
    console.log(`[seed] admin ready: ${ADMIN_EMAIL} (id ${adminRes.rows[0].id})`);

    // 2. A couple of sample teachers so the dashboards aren't empty on first run
    const samplePassHash = await bcrypt.hash('ChangeMe123!', 10);
    const teacherNames = [
      ['ফারহানা বেগম', 'farhana@example.com'],
      ['মোহাম্মদ আলী', 'ali@example.com'],
      ['সাবিনা ইসলাম', 'sabina@example.com']
    ];
    const teacherIds = [];
    for (const [name, email] of teacherNames) {
      const r = await client.query(
        `INSERT INTO users (name, email, password_hash, role, is_verified, nid_verified, bank_verified)
         VALUES ($1,$2,$3,'teacher',TRUE,TRUE,TRUE)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name, email, samplePassHash]
      );
      teacherIds.push(r.rows[0].id);
    }

    // 3. Sample pending course for the approval queue
    await client.query(
      `INSERT INTO courses (title, teacher_id, category, price, status, ai_quality_score)
       SELECT 'IELTS Writing Master', $1, 'IELTS', 1500, 'pending', 92
       WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title = 'IELTS Writing Master')`,
      [teacherIds[0]]
    );

    // 3b. Sample approved course + a couple of orders/enrollments so the
    // Teacher Dashboard has real numbers to show right after seeding.
    const approvedCourseRes = await client.query(
      `INSERT INTO courses (title, teacher_id, category, price, status, ai_quality_score, rating, reviewed_at)
       SELECT 'IELTS Academic Complete', $1, 'IELTS', 1850, 'approved', 96, 4.9, now()
       WHERE NOT EXISTS (SELECT 1 FROM courses WHERE title = 'IELTS Academic Complete')
       RETURNING id`,
      [teacherIds[0]]
    );
    if (approvedCourseRes.rows[0]) {
      const courseId = approvedCourseRes.rows[0].id;
      const studentHash = await bcrypt.hash('ChangeMe123!', 10);
      for (const [name, email] of [['রহিম উদ্দিন', 'student1@example.com'], ['করিম মিয়া', 'student2@example.com']]) {
        const s = await client.query(
          `INSERT INTO users (name, email, password_hash, role)
           VALUES ($1,$2,$3,'student') ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [name, email, studentHash]
        );
        await client.query(
          `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [s.rows[0].id, courseId]
        );
        await client.query(
          `INSERT INTO orders (user_id, source, course_id, amount) VALUES ($1,'course',$2,1850)`,
          [s.rows[0].id, courseId]
        );
      }
    }

    // 3c. Sample publisher + seller accounts with a product each
    const publisherHash = await bcrypt.hash('ChangeMe123!', 10);
    const publisherRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Ruposhi Bangla Publications', 'publisher@example.com', $1, 'publisher')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [publisherHash]
    );
    await client.query(
      `INSERT INTO products (owner_id, type, title, category, price, stock)
       SELECT $1, 'book', 'SSC বাংলা গাইড', 'SSC', 450, 120
       WHERE NOT EXISTS (SELECT 1 FROM products WHERE title = 'SSC বাংলা গাইড')`,
      [publisherRes.rows[0].id]
    );

    const sellerRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('EduHub Mart Seller', 'seller@example.com', $1, 'seller')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [publisherHash]
    );
    await client.query(
      `INSERT INTO products (owner_id, type, title, category, price, stock)
       SELECT $1, 'mart', 'Scientific Calculator FX-991', 'Stationery', 1450, 40
       WHERE NOT EXISTS (SELECT 1 FROM products WHERE title = 'Scientific Calculator FX-991')`,
      [sellerRes.rows[0].id]
    );

    // 4. Sample payouts so the payout tab has real rows
    const payoutSeed = [
      [teacherIds[0], 40000, 'paid'],
      [teacherIds[1], 56250, 'pending'],
      [teacherIds[2], 47500, 'paid']
    ];
    for (const [teacherId, total, status] of payoutSeed) {
      const exists = await client.query(
        'SELECT 1 FROM payouts WHERE teacher_id = $1 AND total_sales = $2', [teacherId, total]
      );
      if (exists.rowCount === 0) {
        await client.query(
          `INSERT INTO payouts (teacher_id, total_sales, platform_cut_pct, status, period_label, paid_at)
           VALUES ($1,$2,20,$3,'2026-08', CASE WHEN $3 = 'paid' THEN now() ELSE NULL END)`,
          [teacherId, total, status]
        );
      }
    }

    // 5. Kids Learning Wing categories + one sample module each (matches
    // the 11 modules already live in index.html's Kids Wing)
    const kidsCats = [
      ['phonics','Phonics & Pronunciation','Phonics ও উচ্চারণ','النطق',1],
      ['tracing','Alphabet & Tracing','বর্ণমালা ও ট্রেসিং','الحروف',2],
      ['cvc','CVC & Sight Words','CVC শব্দ','كلمات',3],
      ['math','Numbers & Math Fun','সংখ্যা ও গণিত','الأرقام',4],
      ['sensory','Colors & Sensory','রঙ ও সেন্সরি','الألوان',5],
      ['science','General Science & World','বিজ্ঞান ও বিশ্ব','العلوم',6],
      ['rhymes','Animated Rhymes','ছড়া','الأناشيد',7],
      ['ethics','Arabic Letters, Ethics & Dua','আরবি বর্ণমালা ও দোয়া','الأخلاق',8],
      ['abacus','Abacus & Mental Math','অ্যাবাকাস','العد',9],
      ['brain','Brain Games & Logic','মস্তিষ্ক খেলা','الألغاز',10],
      ['worksheets','Printable Worksheets','প্রিন্টযোগ্য শিট','أوراق العمل',11]
    ];
    for (const [key, en, bn, ar, order] of kidsCats) {
      await client.query(
        `INSERT INTO kids_categories (category_key, title_bn, title_en, title_ar, display_order)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (category_key) DO UPDATE SET title_bn=EXCLUDED.title_bn, title_en=EXCLUDED.title_en,
           title_ar=EXCLUDED.title_ar, display_order=EXCLUDED.display_order`,
        [key, bn, en, ar, order]
      );
    }

    // 6. Wings (matches index.html's page ids) + a few sample contents so
    // /contents and /feed have something real to return right after seeding.
    const wings = [
      ['academy','একাডেমি','Academy','🎓',1], ['kids','কিডস ও বেবি','Kids & Baby World','🧸',2],
      ['news','নিউজ','News','📰',3], ['community','কমিউনিটি','Community','👥',4],
      ['ai','এআই','AI','🤖',5]
    ];
    for (const [key, bn, en, icon, order] of wings) {
      await client.query(
        `INSERT INTO wings (wing_key, title_bn, title_en, icon_symbol, display_order)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (wing_key) DO UPDATE SET title_bn=EXCLUDED.title_bn, title_en=EXCLUDED.title_en, display_order=EXCLUDED.display_order`,
        [key, bn, en, icon, order]
      );
    }
    const sampleContents = [
      ['academy','ssc','video','SSC পদার্থবিজ্ঞান — অধ্যায় ৩ পূর্ণ ক্লাস', ['ssc','physics']],
      ['kids','phonics','game','Phonics: Letter Sounds Practice', ['kids','phonics','english']],
      ['news','scholarship','article','যুক্তরাজ্যে Chevening স্কলারশিপ ২০২৭ — আবেদনের সময়সূচি', ['scholarship','uk','higherstudy']],
      ['community','bcs','post','BCS প্রিলি প্রস্তুতির রুটিন শেয়ার করলেন একজন সফল ক্যান্ডিডেট', ['bcs','study-tips']],
      ['ai','tutor','article','AI Tutor দিয়ে দ্রুত রিভিশন করার ৫টি কৌশল', ['ai','study-tips']]
    ];
    for (const [wing, cat, kind, title, tags] of sampleContents) {
      await client.query(
        `INSERT INTO contents (wing_type, category_key, content_kind, title, tags)
         SELECT $1,$2,$3,$4,$5
         WHERE NOT EXISTS (SELECT 1 FROM contents WHERE title = $4)`,
        [wing, cat, kind, title, tags]
      );
    }
    // Give one sample student interests/preferred_wings so /feed's
    // personalization is actually testable right after seeding.
    await client.query(
      `UPDATE users SET interests = '{bcs,study-tips}', preferred_wings = '{community,news}'
       WHERE email = 'student1@example.com'`
    );

    await client.query('COMMIT');
    console.log('[seed] done.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
