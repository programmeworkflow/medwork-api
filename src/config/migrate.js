require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./database');

// The schema SQL is embedded here to avoid path resolution issues
// when running from different working directories
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255)  NOT NULL,
  email         VARCHAR(255)  UNIQUE NOT NULL,
  password_hash VARCHAR(255)  NOT NULL,
  phone         VARCHAR(50),
  role          VARCHAR(50)   NOT NULL DEFAULT 'user',
  whatsapp_number      VARCHAR(30),
  whatsapp_enabled     BOOLEAN NOT NULL DEFAULT false,
  monthly_goal         NUMERIC(12,2),
  notifications_config JSONB   NOT NULL DEFAULT '{"below_goal":true,"negative_growth":true,"strong_growth":true,"client_risk":true,"contract_created":true}',
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contracts (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id            VARCHAR(255),
  company_name           VARCHAR(255) NOT NULL,
  cnpj                   VARCHAR(20),
  email                  VARCHAR(255),
  services               JSONB        NOT NULL DEFAULT '[]',
  monthly_value          NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount               NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_value              NUMERIC(12,2) NOT NULL DEFAULT 0,
  observations           TEXT,
  month                  CHAR(7)      NOT NULL,
  start_date             DATE,
  status                 VARCHAR(50)  NOT NULL DEFAULT 'pending',
  conta_azul_customer_id VARCHAR(255),
  conta_azul_contract_id VARCHAR(255),
  created_by             UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_files (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name VARCHAR(500) NOT NULL,
  stored_name   VARCHAR(500) NOT NULL,
  file_path     TEXT,
  file_size     INTEGER,
  contract_id   UUID         REFERENCES contracts(id) ON DELETE SET NULL,
  status        VARCHAR(50)  NOT NULL DEFAULT 'pending',
  processed_at  TIMESTAMPTZ,
  created_by    UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  level       VARCHAR(20)  NOT NULL DEFAULT 'info',
  category    VARCHAR(100),
  message     TEXT         NOT NULL,
  details     JSONB,
  contract_id UUID         REFERENCES contracts(id) ON DELETE SET NULL,
  file_id     UUID         REFERENCES processed_files(id) ON DELETE SET NULL,
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_alerts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_type   VARCHAR(60) NOT NULL,
  channel      VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  phone_number VARCHAR(30),
  message      TEXT        NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'sent',
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contract_id  UUID        REFERENCES contracts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_contracts_month      ON contracts(month);
CREATE INDEX IF NOT EXISTS idx_contracts_status     ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_cnpj       ON contracts(cnpj);
CREATE INDEX IF NOT EXISTS idx_contracts_created_at ON contracts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_contract_id     ON logs(contract_id);
CREATE INDEX IF NOT EXISTS idx_logs_level           ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_created_at      ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_contract_id    ON processed_files(contract_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user_type     ON notification_alerts(user_id, alert_type, sent_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at     ON users;
DROP TRIGGER IF EXISTS trg_contracts_updated_at ON contracts;
CREATE TRIGGER trg_users_updated_at     BEFORE UPDATE ON users     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_contracts_updated_at BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');
    await client.query(SCHEMA_SQL);
    console.log('✅ Schema ready');

    // Seed default admin user
    const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@medwork.com.br';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Medwork@2024';
    const hash = await bcrypt.hash(adminPassword, 10);

    await client.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, 'admin')
      ON CONFLICT (email) DO NOTHING
    `, ['Admin Medwork', adminEmail, hash]);

    console.log(`✅ Admin user: ${adminEmail}`);
    console.log('✅ Migration complete\n');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
