// 面板浏览器级验收：headless Chrome + CDP，真实执行页面 JS 后断言。
// 用法：node scripts/ui-check.mjs
// 断言：时间默认值已填 / 币种下拉=观察池 / 指标下拉=7 项 / 交易所复选框=3 /
//       主题切换按钮可切换 data-theme / 无脚本崩溃（以上断言本身即证明脚本跑完）。
import worker from '../worker.js';

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT_HTTP = 8917;
const PORT_CDP = 9334;
const TMP_DIR = path.join(process.cwd(), '.chrome-tmp');

function log(...a) { console.log(...a); }
function fail(msg) { console.error('FAIL', msg); process.exitCode = 1; }

// 1) 渲染面板 HTML
const res = await worker.fetch(new Request('https://x/'), {}, { waitUntil: () => {} });
const HTML = await res.text();

// 2) 本地 HTTP 服务器：/ 出面板，/api/config 给 mock 观察池
const server = http.createServer((req, res2) => {
  if (req.url === '/api/config') {
    res2.writeHead(200, { 'content-type': 'application/json' });
    res2.end(JSON.stringify({
      watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
      exchanges: ['okx', 'bybit', 'gate'],
      metrics: [],
    }));
    return;
  }
  res2.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res2.end(HTML);
});
await new Promise((r) => server.listen(PORT_HTTP, '127.0.0.1', r));

// 3) 起 headless Chrome
fs.rmSync(TMP_DIR, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run',
  `--remote-debugging-port=${PORT_CDP}`, `--user-data-dir=${TMP_DIR}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 40 && !version; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/version`);
    version = await r.json();
  } catch { await sleep(250); }
}
if (!version) { fail('Chrome CDP 未就绪'); process.exit(1); }

// 4) 开标签页
const tabRes = await fetch(`http://127.0.0.1:${PORT_CDP}/json/new?http://127.0.0.1:${PORT_HTTP}/`, { method: 'PUT' });
const tab = await tabRes.json();

// 5) CDP WebSocket，执行断言
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = ++mid;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') };
  return r.result?.result?.value;
}

await sleep(1200); // 等页面脚本跑完（含 fetch /api/config 回填）

const checks = [];
const t = (name, ok, extra = '') => { checks.push([name, ok, extra]); log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (extra ? '  → ' + extra : '')); };

const toVal = await evalJs(`document.getElementById('to').value`);
const fromVal = await evalJs(`document.getElementById('from').value`);
t('开始时间已填(本地时间默认7天前)', !!fromVal && !isNaN(new Date(fromVal).getTime()), fromVal);
t('结束时间已填(本地时间≈现在)', !!toVal && !isNaN(new Date(toVal).getTime()), toVal);
if (toVal) {
  const driftMin = Math.round((Date.now() - new Date(toVal).getTime()) / 60000);
  t('结束时间与真实时间偏差 < 5 分钟(时区修复)', Math.abs(driftMin) < 5, driftMin + ' 分钟');
}

const nSym = await evalJs(`document.querySelectorAll('#symbol option').length`);
t('币种下拉=6(来自 /api/config mock)', nSym === 6, '实际 ' + nSym);

const nMet = await evalJs(`document.querySelectorAll('#metric option').length`);
const metKeys = await evalJs(`[...document.querySelectorAll('#metric option')].map(o=>o.value).join(',')`);
t('指标下拉=7(全指标)', nMet === 7, metKeys);

const nEx = await evalJs(`document.querySelectorAll('#exchecks input').length`);
t('交易所复选框=3', nEx === 3, '实际 ' + nEx);

const themeBefore = await evalJs(`document.documentElement.dataset.theme`);
await evalJs(`document.getElementById('themeBtn').click()`);
const themeAfter = await evalJs(`document.documentElement.dataset.theme`);
t('主题切换 dark→light', themeBefore === 'dark' && themeAfter === 'light', themeBefore + '→' + themeAfter);
const stored = await evalJs(`localStorage.getItem('cm-theme')`);
t('主题偏好已写入 localStorage', stored === 'light', String(stored));

// 页面脚本是否崩溃的旁证：查询按钮监听器在（点击后状态栏出现文案）
const statusTxt = await evalJs(`(function(){ document.getElementById('run').click(); return new Promise(r=>setTimeout(()=>r(document.getElementById('status').textContent), 800)); })()`, true);
t('点击「查询」后状态栏有响应(脚本未崩)', typeof statusTxt === 'string' && statusTxt.length > 0, JSON.stringify(statusTxt).slice(0, 80));

// 6) 收尾
await fetch(`http://127.0.0.1:${PORT_CDP}/json/close/${tab.id}`).catch(() => {});
ws.close();
chrome.kill();
server.close();
fs.rmSync(TMP_DIR, { recursive: true, force: true });

const bad = checks.filter(([, ok]) => !ok);
log(bad.length ? `\n结论：${bad.length} 项失败` : '\n结论：全部通过 ✅');
process.exitCode = bad.length ? 1 : 0;
