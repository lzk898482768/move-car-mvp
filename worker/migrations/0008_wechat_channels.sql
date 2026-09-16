-- 通知通道开关列（车主侧可独立开启/关闭每个已由超管开通的通道）
-- showdoc_* 列保留以兼容历史数据，但已不再使用。
ALTER TABLE vehicles ADD COLUMN wechat_work_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN wechat_enabled INTEGER NOT NULL DEFAULT 0;
