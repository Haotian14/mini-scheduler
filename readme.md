# Mini Scheduler（轻量级分布式任务调度系统）

这是一个用于学习和演示的 **轻量级分布式任务调度系统（Mini Scheduler）**。  
系统支持 Worker 自动注册、资源感知调度、任务状态跟踪，以及通过 WebSocket 实时推送任务日志，并提供一个可视化前端 Dashboard。

---

## 一、项目背景

在分布式系统中，任务调度是一个非常核心的问题。  
本项目模拟了一个简化版的调度系统，包含：

- 一个 **Master** 作为调度中心
- 多个 **Worker** 作为任务执行节点
- 一个 **前端 Dashboard** 用于实时监控集群状态与任务执行情况

项目重点放在：

- 调度逻辑设计
- 实时通信（WebSocket）
- 前后端协作与可视化展示

---

## 二、系统架构

┌─────────────┐ WebSocket ┌────────────────────┐
│ │ <-------------------> │ │
│ Frontend │ │ Master │
│ (Vue 3) │ REST API │ (Scheduler + API) │
│ │ ---------------------> │ │
└─────────────┘ └─────────┬──────────┘
│
│ HTTP
▼
┌────────────────────┐
│ Worker │
│ (Task Executor) │
└────────────────────┘

---

## 三、主要功能

### 1. Worker 管理

- Worker 启动后自动向 Master 注册
- 定期心跳上报 CPU / 内存使用情况
- 心跳超时后自动标记为 `OFFLINE`

### 2. 任务调度

- 通过 REST API 提交任务
- 任务包含：
  - 执行命令（command）
  - CPU 需求
  - 内存需求
- Master 使用 **Bin Packing（Best-Fit）策略** 分配任务到合适的 Worker

### 3. 任务状态跟踪

- 支持任务状态：
  - `PENDING`
  - `RUNNING`
  - `SUCCESS`
  - `FAILED`
- 状态变化通过 WebSocket 实时推送到前端

### 4. 实时日志流

- Worker 在执行任务时，将 stdout / stderr 实时回传
- Master 通过 WebSocket 将日志流推送到前端
- 前端支持：
  - 实时查看日志
  - 自动滚动到底部（用户上翻时自动暂停）

### 5. 可视化 Dashboard

- Worker 卡片展示 CPU / 内存使用情况
- OFFLINE Worker 自动变灰
- 任务列表实时更新
- 支持点击任务查看日志

---

## 四、技术栈

### 后端

- Node.js
- Express
- WebSocket（ws）
- REST API

### 前端

- Vue 3（Composition API）
- Vite
- Element Plus
- WebSocket

---

## 五、项目结构

project1/
├─ mini-scheduler/
│ ├─ master/ # 调度器（Master）
│ └─ worker/ # 执行节点（Worker）
├─ mini-scheduler-ui/ # 前端 Dashboard
└─ README.md

---

## 六、如何运行项目

### 1️⃣ 启动 Master

```bash
cd mini-scheduler/master
npm install
npm run dev
```

默认监听：

- HTTP / WebSocket：`http://127.0.0.1:3000`

---

### 2️⃣ 启动 Worker（Windows PowerShell）

```powershell
cd mini-scheduler/worker

$env:CPU_TOTAL=4
$env:MEM_TOTAL=8
$env:WORKER_PORT=4001
$env:MASTER_URL="http://127.0.0.1:3000"

npm run dev
```

Worker 启动后会自动注册到 Master。

---

### 3️⃣ 启动前端 Dashboard

```bash
cd mini-scheduler-ui
npm install
npm run dev
```

浏览器访问：

http://localhost:5173

---

### 4️⃣ 提交任务（PowerShell 示例）

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:3000/tasks `
  -Method POST `
  -ContentType "application/json" `
  -Body '{
    "command": "node -e \"console.log(''start''); setTimeout(()=>console.log(''end''), 5000)\"",
    "cpu_required": 1,
    "mem_required": 1
  }'
```

提交后：

- 前端任务表会自动更新
- 任务运行时可点击 `Logs` 查看实时日志

---

## 七、可演示场景

- 多 Worker 同时在线
- 资源不足导致任务 `PENDING`
- Worker 异常退出 → 自动标记 `OFFLINE`
- 任务执行过程中实时查看日志
- 任务完成后状态自动更新

---

## 八、项目特点总结

- 前后端完全解耦
- 使用 WebSocket 实现实时数据推送
- 调度逻辑清晰，易于扩展
- UI 简洁直观，接近真实运维系统体验

---

## 九、说明

本项目为学习与教学用途的简化实现，未涉及安全隔离、持久化存储和复杂容错机制，但整体设计思路可扩展至更复杂的调度系统。
