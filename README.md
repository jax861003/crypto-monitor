# 加密货币资金面监控面板（Cloudflare Workers + D1）

定时从 **Binance / OKX / Bybit / Gate.io** 公开 API 采集价格、24h 成交量、合约持仓量(OI)、资金费率，
存入 **Cloudflare D1**，并提供一个面板按**日期区间**查询走势与区间涨跌，给你的交易做参考。

> 实现取舍：**代理指标（免费）** + **观察池用环境变量 `WATCHLIST` 配置** + **存储仅用 D1** + **部署用 `wrangler deploy` 直接推 Cloudflare（不依赖 GitHub）**。

---

## 先讲清楚两件事

1. **自动化（每 15 分钟采集）是 Cloudflare Workers 自带的 Cron，不是 GitHub。** GitHub 只是代码存放处。所以**完全可以跳过 GitHub**，用 `wrangler deploy` 把代码推上去，Cron 照常跑。
2. **不能用 Cloudflare Pages。** Pages 没有 Cron、也不认 `src/index.js` 入口，页面会直接打不开。本项目是 **Workers** 形态。

---

## 部署方式：直接 `wrangler deploy`（推荐，不碰 GitHub，也不产生 build token）

前置：本地装了 **Node.js（≥18）**。

### 步骤 0：建 D1 数据库（二选一）
- **Dashboard**：Cloudflare 左侧 **Storage & Databases → D1 SQL Database → Create**，名称填 `crypto_monitor`。
- **命令行**：`npx wrangler d1 create crypto_monitor`（记下返回的 id，本方式下面用不到）。

> 建表不用手动：代码 `ensureSchema()` 会在首次采集/查询时自动建表。

### 步骤 1：本地准备并登录
```bash
cd crypto-monitor
npm install
npx wrangler login        # 浏览器弹窗，授权你的 Cloudflare 账号（一次性）
```

### 步骤 2：绑定 D1（Dashboard，变量名必须 `DB`）
部署后（或部署前都行）进入该 Worker：
- **Settings → Bindings → Add → D1 database**
  - **Variable name**：**`DB`** ← 必须叫这个，代码读 `env.DB`
  - **D1 database**：选你建的 `crypto_monitor`
  - 保存。

> 若 `wrangler deploy` 报 "account" 相关错误，先确认 `npx wrangler login` 已成功；必要时在 `wrangler.toml` 顶部加 `account_id = "你的CF账号id"`（Dashboard 右侧「右上角头像 → 账号 ID」可查）。

### 步骤 3：部署（一条命令搞定）
```bash
npx wrangler deploy
```
这一步把 `src/index.js` + `wrangler.toml` 里的配置（**Cron 每 15 分钟** + **WATCHLIST 变量**）全部推上去。Cron 自动生效，无需额外设置。

### 步骤 4：验证
- 打开 `https://crypto-monitor.<你的子域>.workers.dev/` 即面板。
- **想立刻出数**（不必等 Cron）：浏览器访问一次
  `https://crypto-monitor.<你的子域>.workers.dev/api/ingest`
  返回 `{"ok":true,...}` 即已提交后台采集；几秒后回面板查询。
- 健康检查：`/api/health` 应返回 `{"ok":true,...}`。

---

## 观察池 `WATCHLIST`（每加一个币，看板自动多一项）

- 改 `wrangler.toml` 里 `[vars]` 的 `WATCHLIST`（逗号分隔，**大小写不限**），改完重跑 `npx wrangler deploy`。
- 或在 Cloudflare Dashboard → Worker → Settings → Variables 里加 `WATCHLIST`（Type 选 `Variable`）。
- 留空则用代码内置默认 6 币（BTC/ETH/SOL/BNB/XRP/DOGE）。

---

## （可选）GitHub 仅作代码备份，不参与部署

代码已推到 `https://github.com/jax861003/crypto-monitor`，纯备份/版本管理用。
- 改完代码：`git commit` + `git push` 备份。
- **部署仍用 `npx wrangler deploy`**，跟 GitHub 无关。
- 仓库默认分支是 `main`，本地用 `git checkout main` 跟踪即可。

> 不需要在 Cloudflare 里连这个 GitHub 仓库，也不要去配 Workers Builds / build token——那套 Git 集成正是之前部署卡住的根源，现在完全绕开。

---

## 本地先跑通（不用 Cloudflare 也能验证代码逻辑）
```bash
npm install
node scripts/local-check.mjs
```
会验证：根路径返回面板 HTML、`/api/health` 正常、`/api/config` 返回观察池（含大小写归一）。无需网络、无需 Cloudflare。

---

## 环境变量 / 绑定 速查表

| 名称 | 类型 | 在哪填 | 必填 | 说明 |
|---|---|---|---|---|
| `DB` | D1 绑定 | Worker Settings → Bindings → D1 database | **是** | 变量名必须 `DB`，对应代码 `env.DB`；绑定你的 `crypto_monitor` 库 |
| `WATCHLIST` | Variable | `wrangler.toml [vars]` 或 Dashboard Variables | 否 | 观察池，逗号分隔，大小写不限；留空=内置默认 6 币 |

> 部署时**不需要**在 `wrangler.toml` 里填任何 D1 的 UUID——D1 绑定在 Cloudflare Dashboard 完成（见步骤 2）。

---

## 免费额度关键约束

- **Workers Free**：10 万请求/天；单次调用 CPU 仅 10ms（含 Cron）。采集是 I/O 密集，轻量观察池通常能塞进。若被掐，升 **$5/月 Paid**（Cron CPU 提到 30s）。
- **D1 Free**：单库 500MB、500 万行读/天、10 万行写/天。
- **Binance 地理封锁**：`api.binance.com` 对美区 IP 返回 451。Cloudflare 边缘多在非美区，常能通但不保证。代码已优雅降级：Binance 挂了只记另三家。

---

## 指标说明（代理指标）

| 指标 | 含义 | 用途 |
|---|---|---|
| price | 最新价 | 价格走势 |
| volume_24h | 24h 成交量 | 量能（各所口径不一，同所内可比） |
| open_interest | 合约持仓量 | 多空总敞口变化 |
| funding_rate | 资金费率 | 多空情绪（正=多头付费） |

> 想要**真正的交易所链上净流入/流出(Netflow)**，需接 CryptoQuant（$39/月起）或 Glassnode（$29/月起）API，或自建链上追踪。已在 `src/db.js` 留 `taker_buy_volume` 扩展列，后续可对接。

---

## `schema.sql`（首次建表用，可直接在 D1 Console 执行；通常由代码自动建）

```sql
CREATE TABLE IF NOT EXISTS market_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  exchange      TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  price         REAL,
  volume_24h    REAL,
  open_interest REAL,
  funding_rate  REAL,
  taker_buy_volume REAL,
  created_at    INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON market_snapshot(ts);
CREATE INDEX IF NOT EXISTS idx_snap_ex_sym_ts ON market_snapshot(exchange, symbol, ts);
```

---

## 文件结构

```
crypto-monitor/
├─ wrangler.toml        # Worker 配置：入口 src/index.js + 15 分钟 Cron + WATCHLIST；D1 绑定留空，靠 Dashboard 完成
├─ schema.sql           # D1 表结构（通常由代码自动建）
├─ package.json
├─ .gitignore
├─ LICENSE
├─ src/
│  ├─ index.js          # Worker 入口（fetch + 定时 scheduled + /api/config）
│  ├─ config.js         # 环境变量解析：观察池 WATCHLIST（大小写归一）
│  ├─ exchanges.js      # 四家采集 + 归一化
│  ├─ db.js             # D1 写入 + 区间查询 + 自动建表 ensureSchema
│  └─ dashboard.js      # 查询 API + 内联面板
└─ scripts/
   ├─ local-check.mjs   # 本地逻辑验证（无需网络/Cloudflare）
   └─ smoke.mjs         # 本地校验四家交易所端点（需网络）
```
