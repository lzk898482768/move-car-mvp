-- 微信通知改为「公众号模板消息」通道：
--   * 全局配置改为 公众号 AppID / AppSecret / 模板ID / 默认接收 OpenID
--   * 车主可填自己的 OpenID 覆盖全局默认（可选）
ALTER TABLE vehicles ADD COLUMN wechat_openid TEXT;
