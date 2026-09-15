-- 广告位：由超级管理员在后台配置，仅保存图片链接（不上传图片）
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT NOT NULL,              -- 广告位标识，见 worker 中 AD_POSITIONS
  title TEXT NOT NULL DEFAULT '',      -- 备注名，便于后台辨认
  image_url TEXT NOT NULL,             -- 广告图片链接（必填）
  link_url TEXT NOT NULL DEFAULT '',   -- 点击跳转链接（可空）
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_position ON ads (position, enabled, sort_order);
