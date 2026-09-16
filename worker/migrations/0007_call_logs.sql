-- 拨号日志（隐私拨号 / 直拨 都记录）+ 换号短信验证码
--
-- 号码一律 AES-GCM 加密存 *_enc，另存 *_last4 明文后缀用于列表展示与筛选。

CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  channel TEXT NOT NULL,            -- privacy_call | direct_call
  caller_number_enc TEXT,           -- 拨号方号码（访客；平台未返回且访客未填则为空）
  caller_last4 TEXT,                -- 拨号方后 4 位（用于筛选/展示）
  callee_number_enc TEXT,           -- 被叫方号码（车主真实号码）
  callee_last4 TEXT,                -- 被叫方后 4 位
  virtual_number_enc TEXT,          -- 隐私号平台分配的中间号（仅隐私拨号）
  virtual_last4 TEXT,
  status TEXT NOT NULL,             -- success | failed
  error_summary TEXT,
  visitor_ip_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_logs_vehicle ON call_logs (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_channel ON call_logs (channel);
CREATE INDEX IF NOT EXISTS idx_call_logs_status ON call_logs (status);

-- 换号短信验证码
CREATE TABLE IF NOT EXISTS phone_verify_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phone_verify_vehicle ON phone_verify_codes (vehicle_id);
