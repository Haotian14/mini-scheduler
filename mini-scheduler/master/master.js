import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

/**
 * ======================
 * In-memory state
 * ======================
 */
const workers = new Map(); // workerId -> worker
const tasks = new Map(); // taskId -> task
const taskLogs = new Map(); // taskId -> string[]

/**
 * ======================
 * HTTP + WebSocket
 * ======================
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.subscribedTaskId = null;

  ws.on("close", () => wsClients.delete(ws));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "subscribeLog") ws.subscribedTaskId = msg.taskId;
      if (msg.type === "unsubscribeLog") ws.subscribedTaskId = null;
    } catch {}
  });

  // initial snapshot
  wsSend(ws, { type: "cluster:update", workers: snapshotWorkers() });
  wsSend(ws, { type: "tasks:update", tasks: snapshotTasks() });
});

function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    if (msg.type === "task:log" && ws.subscribedTaskId !== msg.taskId) continue;
    ws.send(data);
  }
}

/**
 * ======================
 * Helpers
 * ======================
 */
function now() {
  return Date.now();
}

function makeId(prefix = "id") {
  return `${prefix}_${now()}_${Math.random().toString(16).slice(2)}`;
}

function ringAppendLog(taskId, line, limit = 5000) {
  const arr = taskLogs.get(taskId) ?? [];
  arr.push(line);
  if (arr.length > limit) arr.splice(0, arr.length - limit);
  taskLogs.set(taskId, arr);
}

function snapshotWorkers() {
  return [...workers.values()].map((w) => ({
    id: w.id,
    host: w.host,
    cpuTotal: w.cpuTotal,
    memTotal: w.memTotal,
    cpuUsed: w.cpuUsed,
    memUsed: w.memUsed,
    status: w.status,
    lastHeartbeatAt: w.lastHeartbeatAt,
    runningTasks: [...w.runningTasks],
  }));
}

function snapshotTasks() {
  return [...tasks.values()].map((t) => ({ ...t }));
}

/**
 * ======================
 * Scheduling
 * ======================
 */
function pickWorkerBestFit(cpuReq, memReq) {
  let best = null;
  let bestScore = Infinity;

  for (const w of workers.values()) {
    if (w.status !== "ONLINE") continue;

    const cpuFree = w.cpuTotal - w.cpuUsed;
    const memFree = w.memTotal - w.memUsed;
    if (cpuFree < cpuReq || memFree < memReq) continue;

    const score =
      (cpuFree - cpuReq) / w.cpuTotal + (memFree - memReq) / w.memTotal;

    if (score < bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return best;
}

/**
 * ⭐ 唯一调度入口：所有 Pending 任务都从这里调度
 */
function trySchedulePendingTasks() {
  for (const task of tasks.values()) {
    if (task.status !== "PENDING") continue;

    const w = pickWorkerBestFit(task.cpuRequired, task.memRequired);
    if (!w) continue;

    task.assignedWorkerId = w.id;
    task.status = "RUNNING";
    task.startedAt = now();

    w.cpuUsed += task.cpuRequired;
    w.memUsed += task.memRequired;
    w.runningTasks.add(task.id);

    broadcast({ type: "tasks:update", tasks: snapshotTasks() });
    broadcast({ type: "cluster:update", workers: snapshotWorkers() });

    dispatchToWorker(w, task).catch((e) => {
      task.status = "FAILED";
      task.finishedAt = now();
      ringAppendLog(task.id, `Dispatch failed: ${String(e)}`);
      broadcast({ type: "tasks:update", tasks: snapshotTasks() });
    });
  }
}

/**
 * ======================
 * Worker routes
 * ======================
 */
app.post("/workers/register", (req, res) => {
  const { workerId, host, port, cpuTotal, memTotal } = req.body || {};
  if (!workerId || !port || !cpuTotal || !memTotal) {
    return res.status(400).json({ error: "missing fields" });
  }

  workers.set(workerId, {
    id: workerId,
    host: host || "127.0.0.1",
    port,
    cpuTotal,
    memTotal,
    cpuUsed: 0,
    memUsed: 0,
    status: "ONLINE",
    lastHeartbeatAt: now(),
    runningTasks: new Set(),
  });

  broadcast({ type: "cluster:update", workers: snapshotWorkers() });
  trySchedulePendingTasks();

  res.json({ ok: true });
});

app.post("/workers/heartbeat", (req, res) => {
  const { workerId, cpuUsed, memUsed, runningTaskIds } = req.body || {};
  const w = workers.get(workerId);
  if (!w) return res.status(404).json({ error: "worker not found" });

  w.lastHeartbeatAt = now();
  w.status = "ONLINE";
  if (typeof cpuUsed === "number") w.cpuUsed = cpuUsed;
  if (typeof memUsed === "number") w.memUsed = memUsed;
  if (Array.isArray(runningTaskIds)) w.runningTasks = new Set(runningTaskIds);

  broadcast({ type: "cluster:update", workers: snapshotWorkers() });
  trySchedulePendingTasks();

  res.json({ ok: true });
});

app.post("/workers/task/:taskId/log", (req, res) => {
  const { taskId } = req.params;
  const { chunk, stream } = req.body || {};
  if (!tasks.has(taskId))
    return res.status(404).json({ error: "task not found" });

  const line = `[${stream || "stdout"}] ${chunk ?? ""}`;
  ringAppendLog(taskId, line);
  broadcast({ type: "task:log", taskId, line });

  res.json({ ok: true });
});

app.post("/workers/task/:taskId/finish", (req, res) => {
  const { taskId } = req.params;
  const { exitCode } = req.body || {};

  const t = tasks.get(taskId);
  if (!t) return res.status(404).json({ error: "task not found" });

  t.finishedAt = now();
  t.exitCode = exitCode;
  t.status = exitCode === 0 ? "SUCCESS" : "FAILED";

  const w = workers.get(t.assignedWorkerId);
  if (w) {
    w.cpuUsed = Math.max(0, w.cpuUsed - t.cpuRequired);
    w.memUsed = Math.max(0, w.memUsed - t.memRequired);
    w.runningTasks.delete(taskId);
  }

  broadcast({ type: "tasks:update", tasks: snapshotTasks() });
  broadcast({ type: "cluster:update", workers: snapshotWorkers() });

  trySchedulePendingTasks();
  res.json({ ok: true });
});

/**
 * ======================
 * User routes
 * ======================
 */
app.post("/tasks", (req, res) => {
  const { command, cpu_required, mem_required } = req.body || {};
  if (!command || !cpu_required || !mem_required) {
    return res.status(400).json({ error: "missing fields" });
  }

  const taskId = makeId("task");
  const task = {
    id: taskId,
    command,
    cpuRequired: cpu_required,
    memRequired: mem_required,
    status: "PENDING",
    assignedWorkerId: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };

  tasks.set(taskId, task);
  ringAppendLog(taskId, `Task created: ${command}`);

  broadcast({ type: "tasks:update", tasks: snapshotTasks() });
  trySchedulePendingTasks();

  res.json({ taskId, status: task.status });
});

app.get("/tasks/:taskId/logs", (req, res) => {
  res.json({ lines: taskLogs.get(req.params.taskId) ?? [] });
});

/**
 * ======================
 * Worker dispatch
 * ======================
 */
async function dispatchToWorker(w, task) {
  const resp = await fetch(`http://${w.host}:${w.port}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId: task.id,
      command: task.command,
      cpuRequired: task.cpuRequired,
      memRequired: task.memRequired,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Worker response ${resp.status}`);
  }
}

/**
 * ======================
 * Offline detector
 * ======================
 */
setInterval(() => {
  const deadline = now() - 6000;
  let changed = false;

  for (const w of workers.values()) {
    if (w.lastHeartbeatAt < deadline && w.status !== "OFFLINE") {
      w.status = "OFFLINE";
      w.runningTasks.clear();
      w.cpuUsed = 0;
      w.memUsed = 0;
      changed = true;
    }
  }

  if (changed) {
    broadcast({ type: "cluster:update", workers: snapshotWorkers() });
    broadcast({ type: "tasks:update", tasks: snapshotTasks() });
    trySchedulePendingTasks();
  }
}, 2000);

/**
 * ======================
 * Start server
 * ======================
 */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`[master] listening on http://127.0.0.1:${PORT}`);
  console.log(`[master] ws on ws://127.0.0.1:${PORT}`);
});
