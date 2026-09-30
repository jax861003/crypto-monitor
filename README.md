# 加密货币资金面监控面板（Cloudflare Workers + D1）

定时从 **Binance / OKX / Bybit / Gate.io** 公开 API 采集价格、24h 成交量、合约持仓量(OI)、资金费率，
存入 **Cloudflare D1**，并提供一个面板按**日期区间**查询走势与区间涨跌，给你的交易做参考。

> 实现取舍：**代理指标（免费）** + **观察池用环境变量 `WATCHLIST` 配置** + **存储仅用 D1** + **部署用 Cloudflare Workers（非 Pages）**。

---

## ⚠️ 先读：为什么不能用 Cloudflare Pages（你之前部署打不开的原因）

这项目是 **Cloudflare Workers** 形态，不是 Pages。两个坑：

1. **Pages 不支持定时任务（Cron）。** Pages Functions 只处理 HTTP 请求，没有 `scheduled()`，也没有 Cron Triggers——这是 Cloudflare 的硬限制。本项目的自动采集（每 15 分钟抓一次数据）**只能在 Workers 上跑**，Pages 永远无法自动采集。
2. **入口对不上。** Pages 认 `functions/` 目录或静态文件；本项目入口是 `src/index.js` + `wrangler.toml` 的 `main`，Pages 不认，所以页面直接打不开。

**结论：用 Cloudflare Workers 部署，不要选 Pages。** Workers 同样支持「连接 GitHub 仓库」的纯 Dashboard 流程，不需要你本地敲 wrangler 命令。

---

## 部署总览（全程 Dashboard，不碰命令行）

```
GitHub 仓库(jax861003/crypto-monitor)
      │  Workers & Pages → 导入仓库（Git 集成，自动构建+部署）
      ▼
Cloudflare Worker(crypto-monitor)
      ├─ Cron(每15分钟) → 并行 fetch 4 家 API → 归一化 → 写 D1(crypto_monitor)
      └─ 面板 /  → /api/query → 读 D1 → Chart.js 折线 + 区间涨跌表
```

---

## 步骤 0：创建 D1 数据库（Dashboard）

1. Cloudflare 左侧菜单 **Storage & Databases → D1 SQL Database → Create**。
2. 名称填 `crypto_monitor`，创建。
3. 创建成功后会显示一串 **Database ID（uuid）**，**复制下来**，下一步要用。
4. 进入该数据库 → **Console**，把本项目 `schema.sql` 的内容粘进去执行（或在仓库里也能看到这个文件）。也可以不加表，首次部署后用 Dashboard 的 Console 执行建表 SQL（见文末 `schema.sql` 内容）。

## 步骤 1：修改 `wrangler.toml`（填 D1 的 id）

打开仓库里的 `wrangler.toml`，把这一行的占位符换成你的真实 D1 id：

```toml
database_id = "REPLACE_WITH_YOUR_D1_ID"   →   改成   database_id = "你复制的uuid"
```

> 这个 id 必填，否则部署时绑定失效、采集写不进库。
> （你也可以在 GitHub 网页上直接编辑这个文件，改完提交即可。）

观察池 `WATCHLIST` 同样在 `wrangler.toml` 的 `[vars]` 里改（可选，留空=内置默认 6 币）：

```toml
[vars]
WATCHLIST = "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT"
```

## 步骤 2：Dashboard 导入 GitHub 仓库（创建 Worker）

1. Cloudflare 左侧 **Workers & Pages → Create application → 选 "Import a repository"（导入仓库）**。
2. 授权连接你的 GitHub 账号，选仓库 **`crypto-monitor`**。
3. **Worker 名称必须填 `crypto-monitor`**（要和 `wrangler.toml` 里的 `name` 一致，否则 Git 构建会失败）。
4. 构建配置：
   - **Build command（构建命令）**：`npm install`（或留空）
   - **Deploy command（部署命令）**：`npm run deploy`（= `wrangler deploy`）
5. 点 **Save and Deploy**。Cloudflare 会自动拉仓库、安装依赖、构建并部署。

> 之后你只要 `git push` 到 GitHub，Cloudflare 就会自动重新构建部署（Git 集成）。

## 步骤 3：绑定 D1 数据库 + 设置环境变量（Dashboard）

部署成功后，进入该 Worker：

- **Settings → Bindings → Add → D1 database**
  - Variable name（变量名）：**`DB`**  ← 必须叫这个，代码里读的就是 `env.DB`
  - D1 database：选你建的 **`crypto_monitor`**
  - 保存。
- **Settings → Variables and Secrets → Add variable**（Type 选 `Variable`，不是 Secret）
  - Name：`WATCHLIST`，Value：`BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT`（可选，不填用默认）
  - 保存。

> 如果 `wrangler.toml` 里已经写了 `WATCHLIST`，这里不填也行；两者同时有则以 Dashboard 为准。

## 步骤 4：验证

- 打开 `https://crypto-monitor.<你的子域>.workers.dev/` 就是面板。
- Cron 每 15 分钟自动采集。**想立刻出数**，浏览器访问一次：
  `https://crypto-monitor.<你的子域>.workers.dev/api/ingest`
  返回 `{"ok":true,...}` 即已提交后台采集；几秒后回面板查询。
- 健康检查：`/api/health` 应返回 `{"ok":true,...}`。

---

## 面板用法

打开根路径面板：

- **币种**：下拉框 = 你 `WATCHLIST` 里的每一项（自动生成，加一个币就多一项）。
- **指标**：价格 / 24h 成交量 / 合约持仓量(OI) / 资金费率。
- **交易所**：四个复选框（Binance/OKX/Bybit/Gate），可多选叠加对比。
- **开始/结束时间**：选日期区间，点「查询」看折线 + 区间涨跌汇总表（首值/末值/涨跌幅）。

---

## 环境变量 / 绑定 速查表

| 名称 | 类型 | 在哪填 | 必填 | 说明 |
|---|---|---|---|---|
| `DB` | D1 绑定 | Worker Settings → Bindings → D1 database | **是** | 变量名必须 `DB`，对应代码 `env.DB`；绑定你的 `crypto_monitor` 库 |
| `REPLACE_WITH_YOUR_D1_ID` | D1 id | `wrangler.toml` 的 `database_id` | **是** | 换成真实 D1 uuid |
| `WATCHLIST` | Variable | `wrangler.toml [vars]` 或 Dashboard Variables | 否 | 观察池，逗号分隔，大小写不限；留空=内置默认 6 币 |

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

## `schema.sql`（首次建表用，可直接在 D1 Console 执行）

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
├─ wrangler.toml        # Worker 配置：入口 src/index.js + D1 绑定 DB + 15 分钟 Cron + WATCHLIST
├─ schema.sql           # D1 表结构
├─ package.json
├─ .gitignore
├─ LICENSE
├─ src/
│  ├─ index.js          # Worker 入口（fetch + 定时 scheduled + /api/config）
│  ├─ config.js         # 环境变量解析：观察池 WATCHLIST
│  ├─ exchanges.js      # 四家采集 + 归一化
│  ├─ db.js             # D1 写入 + 区间查询
│  └─ dashboard.js      # 查询 API + 内联面板
└─ scripts/smoke.mjs    # 本地端点校验（需本地 Node，非部署必需）
```

> 部署是 **Dashboard Git 集成**自动完成，不需要本地 `wrangler deploy`。
> 如果你坚持想用 Pages：Pages 无 Cron，自动采集会失效，只能靠外部定时器访问 `/api/ingest` 或另起一个 Cron Worker 来触发——不推荐，直接用 Workers 最简单。
