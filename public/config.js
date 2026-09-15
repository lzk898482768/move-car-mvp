// 前端全局配置
// "same-origin"：通过 Pages Functions 服务绑定内部直连 Worker（推荐，需在 Pages 设置 → 绑定
//   添加服务绑定：变量名 MOVE_CAR_API → 服务 move-car-api，见 functions/api/[[path]].js）。
// 也可改为直连地址，例如：
//   window.MOVE_CAR_API_BASE = "https://api.kxkj.cc.cd";
//   window.MOVE_CAR_API_BASE = "https://move-car-api.your-subdomain.workers.dev";
// 留空时，页面会在运行时提示你手动填入（会存到 localStorage，方便本地调试）。
window.MOVE_CAR_API_BASE = "same-origin";
window.MOVE_CAR_DEMO_MODE = false;
