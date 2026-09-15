// Pages Functions：把本站 /api/* 请求通过「服务绑定」内部转发给 move-car-api Worker。
// 无需公网 DNS，不走跨域，最稳定。
//
// 需要在 Pages 项目 设置 → 绑定 中添加：
//   类型：服务绑定（Worker）
//   变量名称：MOVE_CAR_API
//   服务：move-car-api（环境：production）

function jsonResponse(obj, status = 500) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequest = async ({ request, env }) => {
  const service = env && env.MOVE_CAR_API;
  if (!service) {
    return jsonResponse({
      error: "no_service_binding",
      message: "Pages 未配置服务绑定 MOVE_CAR_API（设置 → 绑定 → 添加服务绑定）",
    }, 500);
  }
  // Worker 按路径路由，直接转发原始请求（method / headers / body 全保留）
  return service.fetch(request);
};
