/**
 * Lexora 匿名统计接收端 — Cloudflare Worker（免费额度绰绰有余）。
 *
 * 部署（约 5 分钟，一次性）：
 *   1. Cloudflare Dashboard → Workers & Pages → Create Worker，粘贴本文件
 *   2. Settings → Bindings → 添加 Analytics Engine dataset，变量名 LEXORA_STATS
 *   3. 部署后得到 https://<name>.<account>.workers.dev
 *   4. 把该 URL 填进插件 packages/obsidian/src/telemetry.ts 的 TELEMETRY_ENDPOINT，发版
 *
 * 查询：Dashboard → Analytics Engine，或 SQL API（按 version/platform/tier 聚合）。
 * 不记录 IP、不写 Cookie、不返回任何标识。
 */
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    let p;
    try {
      p = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    if (typeof p?.id !== 'string' || p.id.length > 64) return new Response(null, { status: 400 });
    env.LEXORA_STATS?.writeDataPoint({
      // 维度（可聚合）
      blobs: [
        String(p.v ?? '').slice(0, 20),
        String(p.platform ?? '').slice(0, 10),
        String(p.tier ?? '').slice(0, 10),
        String(p.wordMagnitude ?? '').slice(0, 10),
      ],
      doubles: [Number(p.lessonsThisMonth) || 0],
      // 同一安装的去重索引（随机 UUID，与任何身份无关）
      indexes: [p.id.slice(0, 32)],
    });
    return new Response(null, { status: 204 });
  },
};
