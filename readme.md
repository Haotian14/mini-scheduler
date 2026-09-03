# Nimbus Scheduler（轻量级分布式任务调度系统）

一个面向本地开发与小型集群的轻量级分布式任务调度系统：Master 负责资源感知调度与任务生命周期管理，Worker 负责执行任务并回传日志，前端 Dashboard 通过 WebSocket 实时展示集群状态。

**在线演示**：<https://haotian14.github.io/mini-scheduler/>

演示页面里跑的**不是录像、也不是重写的假算法**——它直接 import 了 Master 的 `ClusterState`、`Scheduler`、`loadConfig` 这三个真实模块（它们不依赖任何 Node API），在浏览器里对着一队模拟 Worker 运行。被替换掉的只有两样真正需要机器的东西：到 Worker 的 HTTP 分发，以及子进程执行。所以你在页面上看到的调度、预占、老化屏障、重试、掉线回收，全都是生产代码路径。详见第 7 节。

> **定位说明**：这是一个**教学与作品集性质的简化实现**，用来把调度、实时通信、故障恢复这几件事完整地做对。它没有持久化存储、没有沙箱隔离、也没有多 Master 高可用，因此不能直接用于生产环境。第 9 节列出了明确的能力边界。

---

## 1. 快速开始

需要 Node.js >= 20。

```bash
git clone <repo-url>
cd mini-scheduler
npm install          # 一次安装三个 workspace 的依赖
```

开三个终端：

```bash
# 终端 1：Master
npm run dev:master

# 终端 2：Worker（可以按同样方式启动多个，注意端口和 ID 不要重复）
WORKER_ID=alpha WORKER_PORT=4001 CPU_TOTAL=4 MEM_TOTAL=8 npm run dev:worker

# 终端 3：Dashboard
npm run dev:ui       # http://localhost:5173
```

Windows PowerShell 里设置环境变量：

```powershell
$env:WORKER_ID="alpha"; $env:WORKER_PORT="4001"; $env:CPU_TOTAL="4"; $env:MEM_TOTAL="8"
npm run dev:worker
```

提交一个任务：

```bash
curl -X POST http://127.0.0.1:3000/tasks \
  -H 'content-type: application/json' \
  -d '{"command":"node -e \"for(let i=0;i<5;i++)console.log(i)\"","cpu_required":1,"mem_required":1}'
```

### Docker 一键启动

```bash
SCHEDULER_TOKEN=$(openssl rand -hex 16) docker compose up --build
# Dashboard: http://localhost:8080   Master: http://localhost:3000
```

这套 compose 会拉起 1 个 Master、2 个不同规格的 Worker 和 Dashboard。

---

## 2. 系统架构

```
┌──────────────┐   WebSocket（快照 + 增量事件）  ┌────────────────────────┐
│              │ <───────────────────────────── │                        │
│  Dashboard   │                                │        Master          │
│   (Vue 3)    │   REST（提交 / 取消 / 查询）    │  调度 + 生命周期 + API  │
│              │ ─────────────────────────────> │                        │
└──────────────┘                                └───────┬────────────────┘
                                                        │
                              POST /run、/tasks/:id/cancel│  ▲ 注册、心跳、
                                                        ▼  │  日志、结果上报
                                                ┌────────────────────────┐
                                                │        Worker          │
                                                │   进程执行 + 日志批传    │
                                                └────────────────────────┘
```

代码结构：

```
.
├─ mini-scheduler/
│  ├─ master/
│  │  ├─ master.js              # 启动入口（信号处理、优雅退出）
│  │  ├─ src/
│  │  │  ├─ config.js           # 所有可调参数的唯一来源
│  │  │  ├─ state.js            # 集群状态：预占 vs 上报的资源账本
│  │  │  ├─ scheduler.js        # 放置策略（纯函数）+ 调度循环
│  │  │  ├─ events.js           # WebSocket 增量事件广播
│  │  │  ├─ dispatcher.js       # 到 Worker 的 HTTP 客户端
│  │  │  ├─ server.js           # 依赖装配
│  │  │  ├─ *.d.ts              # 类型声明（前端演示模式复用这些模块）
│  │  │  └─ http/               # 路由、CORS、鉴权中间件
│  │  └─ test/                  # 40 个测试，含端到端
│  └─ worker/
│     ├─ worker.js
│     ├─ src/{config,reporter,runner,server,auth}.js
│     └─ test/                  # 16 个测试
├─ mini-scheduler-ui/           # Vue 3 + TypeScript + Vite
│  └─ src/demo/                # 浏览器内的模拟集群（复用 Master 真实模块）
├─ docker-compose.yml
└─ .github/workflows/
   ├─ ci.yml                   # lint + 类型 + 测试 + 构建（Node 20 / 22）
   └─ pages.yml                # 构建演示版并发布到 GitHub Pages
```

---

## 3. 调度策略

### 3.1 放置：归一化 Best-Fit

`planAssignments()` 是一个**纯函数**：输入 Worker 快照、待调度队列和当前时间，输出分配方案。没有 I/O，因此策略本身可以被直接单元测试。

打分方式是归一化的剩余率，越低表示装得越紧：

```
score = (cpuFree - cpuReq) / cpuTotal + (memFree - memReq) / memTotal
```

除以总量而不是直接比较绝对剩余，是为了让不同规格的节点可比：4 核机器上剩 1 核，和 32 核机器上剩 1 核，含义完全不同。

### 3.2 防饥饿：Backfill + 老化屏障

纯 Best-Fit 的问题是大任务会被源源不断的小任务插队饿死。这里的规则是：

- 队列按入队时间 FIFO 遍历；
- 排不下的任务**默认跳过**，让后面的小任务回填（backfill），保证吞吐；
- 但一旦队头任务等待超过 `AGING_MS`（默认 15s），它就变成一道**屏障**：调度在此停止，后面的任务不许越过它。

这样大任务的等待时间被"运行中任务排空所需时间"所限制，而不是无界的。特例：需求超过所有在线节点**总容量**的任务永远不构成屏障（否则会锁死整个队列），它会被单独标记并在日志里说明原因。

### 3.3 重试、超时与故障转移

| 情况 | 处理方式 |
|---|---|
| 分发失败（Worker 连不上 / 返回错误） | 回滚资源预占，任务回队列，该 Worker 进入 `RETRY_COOLDOWN_MS` 冷却，下次优先派给别的节点 |
| 任务超过 `TASK_TIMEOUT_MS` | Master 通知 Worker 终止进程，任务按重试策略回队列 |
| Worker 心跳超时 | 标记 `OFFLINE`，其上所有任务回队列，容量清零 |
| Worker 重新注册（重启） | 视为进程表已清空，之前认为在跑的任务全部回队列 |
| 重试次数用尽 | 任务置为 `FAILED`，并记录最后一次错误原因 |

---

## 4. 三个值得说明的设计决策

### 4.1 资源账本：`max(预占, 上报)`

这是本项目最关键的一处正确性设计。每个 Worker 上有两组独立的数字：

- `cpuReserved / memReserved`：Master 分配任务时立刻记账，**在分发的网络请求发出之前**就已经生效；
- `cpuReported / memReported`：Worker 心跳里上报的实际占用。

有效占用取两者的**最大值**。这样做同时挡住了两个方向的错误：

- 在"Master 已预占、Worker 还没起进程"的窗口里到达的心跳（上报为 0），**不会**把预占抹掉——否则同一份容量会被分配两次，这是原版实现里真实存在的竞态；
- Worker 上跑着 Master 不知道的负载时，这部分占用**仍然**计入容量，不会被乐观地忽略。

两个数字会在一个心跳周期内自然收敛。同理，"哪些任务在这个节点上跑"以 Master 侧的 `assignedTaskIds` 为准，心跳里的 `runningTaskIds` 只用于观测与对账——否则节点掉线时，那些刚分配还没被上报的任务会永远卡在 `RUNNING`。

对应的回归测试：`master/test/state.test.js` 中的
`"a heartbeat cannot erase a reservation the scheduler just made"`。

### 4.2 WebSocket：一次快照 + 增量事件

原来的实现在每次心跳（每个 Worker 每 2 秒）都向所有前端广播**全量**的 Worker 与任务列表，复杂度是 O(任务总数 × Worker 数)，任务攒到几百个就明显吃不消了。

现在：客户端连上时收到一次 `snapshot`，之后只收 `worker:upsert` / `task:upsert` / `task:remove` 等增量事件，并且在 `BROADCAST_INTERVAL_MS`（默认 100ms）的窗口内合并成一帧发出。日志只推送给订阅了该任务的连接。

端到端测试会断言：快照之后不再出现任何全量重广播。

### 4.3 日志：批量上报 + 有界缓冲

Worker 原本每收到一个 stdout chunk 就发一个 HTTP 请求，一个 `yes` 命令就能把 Master 打满。现在按**时间或字节**双阈值批量上报，缓冲区有硬上限，超出后丢弃并在日志里明确标注丢了多少行——宁可丢日志，也不让内存无界增长。

结果上报（`finish`）则相反，它必须送达：带指数退避重试；即使最终失败，Master 侧的超时清扫也会兜底回收任务，不会永久泄漏资源。

---

## 5. API

除 `GET /health` 外，所有接口在配置了 `SCHEDULER_TOKEN` 时都需要
`Authorization: Bearer <token>`。WebSocket 通过 `?token=` 传递。

### 用户接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/tasks` | 提交任务：`{command, cpu_required, mem_required, max_attempts?, timeout_ms?}` |
| `GET` | `/tasks` | 任务列表（按创建时间倒序，`?limit=`） |
| `GET` | `/tasks/:id` | 单个任务 |
| `GET` | `/tasks/:id/logs` | 历史日志 |
| `POST` | `/tasks/:id/cancel` | 取消（PENDING 或 RUNNING 均可） |
| `GET` | `/workers` | Worker 列表 |
| `GET` | `/health` | 健康检查（公开） |

### Worker 回调接口

`POST /workers/register`、`/workers/heartbeat`、`/workers/deregister`、
`/workers/task/:id/log`、`/workers/task/:id/finish`

### WebSocket 帧

```jsonc
// 连接后一次
{ "type": "snapshot", "serverTime": 1730000000000, "workers": [...], "tasks": [...] }

// 之后的增量（100ms 内合并）
{ "type": "batch", "serverTime": ..., "events": [
    { "type": "worker:upsert", "worker": {...} },
    { "type": "task:upsert",   "task": {...} }
]}

// 仅推送给订阅方
{ "type": "task:log", "taskId": "task_...", "lines": ["[stdout] ..."] }
```

客户端可发送 `{"type":"subscribeLog","taskId":"..."}` / `{"type":"unsubscribeLog"}`。

任务状态：`PENDING` → `RUNNING` → `SUCCESS` / `FAILED` / `CANCELLED`。

---

## 6. 配置

完整清单见 `mini-scheduler/master/.env.example`、`mini-scheduler/worker/.env.example`
和 `mini-scheduler-ui/.env.example`。最常用的几个：

| 变量 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| `SCHEDULER_TOKEN` | 全部 | 空 | 共享密钥；`NODE_ENV=production` 时**必填**，否则拒绝启动 |
| `CORS_ORIGIN` | Master | `http://localhost:5173` | 允许的浏览器来源，默认不是 `*` |
| `TASK_TIMEOUT_MS` | Master | `1800000` | 单次尝试的时间上限 |
| `MAX_ATTEMPTS` | Master | `3` | 每个任务的总尝试次数 |
| `AGING_MS` | Master | `15000` | 老化屏障阈值 |
| `TASK_RETENTION` | Master | `500` | 内存中保留的已结束任务数 |
| `CPU_TOTAL` / `MEM_TOTAL` | Worker | `4` / `8` | 声明的容量（不是实测宿主机资源） |

---

## 7. 在线演示与部署

### 7.1 演示模式

GitHub Pages 只能托管静态文件，而 Master 和 Worker 都是常驻 Node 进程——Worker 还要 `spawn()` 执行命令。把这样一个服务挂到公网等于把 RCE 开放给所有人，所以**只有前端被部署，后端在浏览器里模拟**。

模拟的边界划得很清楚：

| 部分 | 演示模式下 |
|---|---|
| `ClusterState`（资源账本、掉线回收、保留策略） | **真实模块**，原样运行 |
| `Scheduler`（best-fit、backfill、老化屏障、重试、超时清扫） | **真实模块**，原样运行 |
| `loadConfig`（参数） | **真实模块**，只是把时间常数调快便于观看 |
| 到 Worker 的 HTTP 分发 | 模拟：定时器"跑"进程，按同样的 state API 回调 |
| Worker 心跳与子进程 | 模拟：同样的间隔上报占用，按脚本吐日志 |

这三个模块之所以能直接搬进浏览器，是因为重构时它们就被写成了零依赖的纯模块（`import` 数量为 0），Master 的 `package.json` 通过 `exports` 把它们单独暴露出来，前端以 workspace 依赖引用。

页面上有三个按钮可以主动触发场景：

- **Crash a worker** —— 让一个节点停止心跳，观察它变 `OFFLINE`、其上任务回队列并重新分配（表格里会显示 `attempt 2/3`）
- **Queue a whole-node job** —— 提交一个需要整台最大节点的任务，观察小任务先 backfill、超过 `AGING_MS` 后屏障生效
- **Pause traffic** —— 停掉自动生成的背景任务，方便你自己提交任务观察

本地跑演示模式：

```bash
VITE_DEMO=true npm run dev:ui
```

也可以在任何部署上加 `?demo=1` 强制进入演示模式，或用 `?demo=0` 强制连真实 Master。

### 7.2 部署到 GitHub Pages

`.github/workflows/pages.yml` 在 push 到 `main` 时构建并发布。仓库设置里需要把
**Settings → Pages → Source** 选成 **GitHub Actions**（只需一次）。

构建时注入两个变量：`VITE_DEMO=true` 打开演示模式，`BASE_PATH=/<repo>/` 处理
Pages 项目站点的子路径。

### 7.3 部署真实集群

不要把 Master / Worker 暴露到公网——它们会执行任意 shell 命令，在补上任务沙箱（见第 9 节）之前，这等同于开放 RCE。真要多机部署，请放在内网或 VPN 后面，并务必设置 `SCHEDULER_TOKEN`。

---

## 8. 开发

```bash
npm run check         # lint + 格式检查 + 类型检查 + 测试 + 构建，CI 跑的就是这套
npm test              # 56 个测试：Master 40 + Worker 16
npm run lint          # ESLint（含 vue / typescript-eslint）
npm run format        # Prettier 写入
npm run typecheck     # vue-tsc --noEmit
```

测试分四层，都不依赖外部服务：

1. **策略层**（`scheduler.test.js`）：对纯函数 `planAssignments` 断言 best-fit、backfill、老化屏障、冷却、不可行任务等行为；
2. **状态层**（`state.test.js`）：资源账本、掉线回收、重试耗尽、保留策略、日志环形缓冲；
3. **接口层**（`api.test.js`、`runner.test.js`）：真实 HTTP，注入假的分发器；覆盖鉴权、CORS、参数校验、取消；
4. **端到端**（`e2e.test.js`）：真的 Master + 真的 Worker + 真的 WebSocket 客户端，跑真实进程；其中一个用例用 `SIGKILL` 杀掉 Worker 进程，验证心跳超时能把任务捞回队列。

CI（GitHub Actions）在 Node 20 与 22 上跑上述全部内容，外加 `npm audit`。

---

## 9. 能力边界（明确不做的事）

这些是有意留下的边界，不是遗漏：

- **无持久化**：Master 重启后集群状态与任务全部丢失。上生产需要一层存储（以及基于它的 leader 选举）。
- **无沙箱隔离**：任务以 Worker 进程的身份直接执行 shell 命令。`SCHEDULER_TOKEN` 只能防止未授权调用，**不能**限制被授权者能做什么。真实环境需要容器 / cgroup / 独立用户来隔离。
- **共享密钥不等于用户认证**：Dashboard 里的 token 会被打进前端产物，任何能打开页面的人都拿得到。它挡住的是"任意网页顺手打你的 localhost"，不是多用户权限。
- **容量是声明值**：`CPU_TOTAL` / `MEM_TOTAL` 是 Worker 自己声明的额度，不会真的去限制进程实际使用多少资源。
- **单 Master**：Master 是单点，没有主备切换。
- **无任务依赖 / DAG / 定时**：只有扁平的任务队列。

---

## 10. 许可证

[MIT](./LICENSE)
