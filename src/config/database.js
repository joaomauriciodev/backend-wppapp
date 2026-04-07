const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        whatsapp_connected BOOLEAN DEFAULT FALSE,
        token_limit INTEGER NOT NULL DEFAULT 100000,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        rules_paused_by_limit BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS auto_reply_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        contact_name VARCHAR(255),
        contact_phone VARCHAR(30) NOT NULL,
        scope VARCHAR(10) NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'groups', 'both')),
        tone VARCHAR(50) NOT NULL DEFAULT 'friendly',
        extra_prompt TEXT,
        active BOOLEAN DEFAULT TRUE,
        reply_delay INTEGER NOT NULL DEFAULT 5,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, contact_phone)
      );

      CREATE TABLE IF NOT EXISTS auto_reply_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id UUID REFERENCES auto_reply_rules(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        chat_id VARCHAR(255),
        incoming_message TEXT,
        outgoing_message TEXT,
        tone VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_auto_reply_rules_user_id ON auto_reply_rules(user_id);
      CREATE INDEX IF NOT EXISTS idx_auto_reply_logs_rule_id ON auto_reply_logs(rule_id);
    `);

    // Migrations for existing installs
    await client.query(`
      ALTER TABLE auto_reply_rules ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(30);
      ALTER TABLE auto_reply_rules ADD COLUMN IF NOT EXISTS reply_delay INTEGER NOT NULL DEFAULT 5;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS token_limit INTEGER NOT NULL DEFAULT 100000;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_used INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rules_paused_by_limit BOOLEAN NOT NULL DEFAULT FALSE;
    `).catch(() => {});

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ Error initializing database:', err);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };