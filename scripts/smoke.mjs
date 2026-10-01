// 本地校验脚本：不依赖 Cloudflare，纯 Node 跑一遍采集逻辑，确认四家端点可用、字段能解析。
// 用法：node scripts/smoke.mjs
import { collectAll } from '../src/exchanges.js';
import { getWatchlist } from '../src/config.js';

// 直接用内置默认观察池；也可改成自己的币种列表
const { rows, detail } = await collectAll(getWatchlist({}));

console.log('总记录数：', rows.length);
const byEx = {};
for (const r of rows) (byEx[r.exchange] ||= []).push(r);
for (const [ex, list] of Object.entries(byEx)) {
  console.log(`\n[${ex}] 命中 ${list.length} 条`);
  console.log('  示例：', JSON.stringify(list[0]));
}
for (const d of detail) {
  if (!d.ok) console.log(`\n[${d.exchange}] 采集失败：${d.error}`);
}
const failed = detail.filter((d) => !d.ok).map((d) => d.exchange);
if (failed.length) console.log('\n未返回数据的交易所（可能被地理封锁/网络限制）：', failed.join(', '));
