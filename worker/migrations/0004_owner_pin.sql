-- 车主管理密码（车牌 + PIN 找回管理入口）
ALTER TABLE vehicles ADD COLUMN owner_pin_hash TEXT;
