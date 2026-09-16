-- 预生成挪车二维码：后台批量出码 → 车主扫码绑定 → 绑定后再扫即进入挪车界面
CREATE TABLE IF NOT EXISTS qr_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code_token   TEXT NOT NULL UNIQUE,          -- 印在二维码里的令牌
  batch_no     TEXT NOT NULL DEFAULT '',      -- 批次号，便于按批打印/管理
  status       TEXT NOT NULL DEFAULT 'unbound', -- unbound | bound | disabled
  vehicle_id   INTEGER,                       -- 绑定后的车辆
  note         TEXT NOT NULL DEFAULT '',
  bound_at     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_codes_token ON qr_codes(code_token);
CREATE INDEX IF NOT EXISTS idx_qr_codes_status ON qr_codes(status);
CREATE INDEX IF NOT EXISTS idx_qr_codes_batch ON qr_codes(batch_no);
