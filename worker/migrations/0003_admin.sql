-- 超级管理员 + 全局通知配置 + 找回限流
CREATE TABLE IF NOT EXISTS global_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_username ON admin_sessions (username);

-- 找回/限流用的轻量计数表
CREATE TABLE IF NOT EXISTS rate_logs (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
