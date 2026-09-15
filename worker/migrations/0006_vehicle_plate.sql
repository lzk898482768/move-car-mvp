-- 车牌明文（AES-GCM 加密存储）
-- 后台「车牌管理」需要能编辑车牌并导出车牌清单，仅靠 plate_number_hash + 脱敏串无法还原原文。
-- 加密方式与手机号一致（DATA_ENCRYPTION_KEY），仅超级管理员与车主本人可解出。
ALTER TABLE vehicles ADD COLUMN plate_number_encrypted TEXT;
