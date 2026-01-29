import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

/**
 * In-memory state (demo)
 */
const workers = new Map(); // workerId -> worker
const tasks = new Map(); // taskId -> task
const taskLogs = new Map(); // taskId -> string[] (ring buffer)

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * WS clients
 */
const wsClients = new Set();

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));

  // optional: allow subscribing logs per task
  ws.subscribedTaskId = null;

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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    // If it's a log message, only send to subscribers of that task (or if no filtering desired, remove this if)
    if (msg.type === "task:log") {
      if (ws.subscribedTaskId !== msg.taskId) continue;
    }
    ws.send(data);
  }
}
function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/**
 * Helpers
 */
function now() {
  return Date.now();
}
function makeId(prefix = "id") {
  return `${prefix}_${now()}_${Math.random().toString(16).slice(2)}`;
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

function ringAppendLog(taskId, line, limit = 5000) {
  const arr = taskLogs.get(taskId) ?? [];
  arr.push(line);
  if (arr.length > limit) arr.splice(0, arr.length - limit);
  taskLogs.set(taskId, arr);
}

/**
 * Bin packing (Best-Fit)
 * Choose feasible worker with minimal leftover score.
 */
function pickWorkerBestFit(cpuReq, memReq) {
  let best = null;
  let bestScore = Infinity;

  for (const w of workers.values()) {
    if (w.status !== "ONLINE") continue;

    const cpuFree = w.cpuTotal - w.cpuUsed;
    const memFree = w.memTotal - w.memUsed;

    if (cpuFree < cpuReq || memFree < memReq) continue;

    // smaller leftover => better fit
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
 * Routes - Worker side
 */
app.post("/workers/register", (req, res) => {
  const { workerId, host, cpuTotal, memTotal, port } = req.body || {};
  if (!workerId || !cpuTotal || !memTotal || !port) {
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
    lastHeartbeatAt: now(),
    status: "ONLINE",
    runningTasks: new Set(),
  });

  broadcast({ type: "cluster:update", workers: snapshotWorkers() });
  return res.json({ ok: true });
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
  return res.json({ ok: true });
});

app.post("/workers/task/:taskId/log", (req, res) => {
  const { taskId } = req.params;
  const { chunk, stream } = req.body || {};
  if (!tasks.has(taskId))
    return res.status(404).json({ error: "task not found" });

  const line = `[${stream || "stdout"}] ${chunk ?? ""}`;
  ringAppendLog(taskId, line);

  broadcast({ type: "task:log", taskId, line });
  return res.json({ ok: true });
});

app.post("/workers/task/:taskId/finish", (req, res) => {
  const { taskId } = req.params;
  const { exitCode } = req.body || {};

  const t = tasks.get(taskId);
  if (!t) return res.status(404).json({ error: "task not found" });

  t.finishedAt = now();
  t.exitCode = exitCode;

  if (exitCode === 0) t.status = "SUCCESS";
  else t.status = "FAILED";

  // release resources
  const w = workers.get(t.assignedWorkerId);
  if (w) {
    w.cpuUsed = Math.max(0, w.cpuUsed - t.cpuRequired);
    w.memUsed = Math.max(0, w.memUsed - t.memRequired);
    w.runningTasks.delete(taskId);
  }

  broadcast({ type: "tasks:update", tasks: snapshotTasks() });
  broadcast({ type: "cluster:update", workers: snapshotWorkers() });

  return res.json({ ok: true });
});

/**
 * Routes - User side
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

  // schedule immediately (demo)
  const w = pickWorkerBestFit(cpu_required, mem_required);
  if (!w) {
    ringAppendLog(taskId, "No available worker for this task.");
    return res.json({
      taskId,
      status: "PENDING",
      note: "no available worker yet",
    });
  }

  // assign
  task.assignedWorkerId = w.id;
  task.status = "RUNNING";
  task.startedAt = now();

  w.cpuUsed += cpu_required;
  w.memUsed += mem_required;
  w.runningTasks.add(taskId);

  broadcast({ type: "tasks:update", tasks: snapshotTasks() });
  broadcast({ type: "cluster:update", workers: snapshotWorkers() });

  // dispatch to worker
  dispatchToWorker(w, task).catch((e) => {
    ringAppendLog(taskId, `Dispatch failed: ${String(e)}`);
    task.status = "FAILED";
    task.finishedAt = now();
    broadcast({ type: "tasks:update", tasks: snapshotTasks() });
  });

  return res.json({ taskId, status: task.status, assignedWorkerId: w.id });
});

app.get("/tasks/:taskId", (req, res) => {
  const t = tasks.get(req.params.taskId);
  if (!t) return res.status(404).json({ error: "not found" });
  return res.json(t);
});

app.get("/tasks/:taskId/logs", (req, res) => {
  const arr = taskLogs.get(req.params.taskId) ?? [];
  return res.json({ lines: arr });
});

/**
 * dispatch helper
 */
async function dispatchToWorker(w, task) {
  // Node18 has fetch built-in. If your Node is older, install node-fetch.
  const url = `http://${w.host}:${w.port}/run`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId: task.id,
      command: task.command,
      cpuRequired: task.cpuRequired,
      memRequired: task.memRequired,
      masterUrl: `http://127.0.0.1:${PORT}`,
    }),
  });
  if (!resp.ok) throw new Error(`worker resp ${resp.status}`);
}

/**
 * offline detector
 */
setInterval(() => {
  const deadline = now() - 6000; // 6s no heartbeat => OFFLINE
  let changed = false;

  for (const w of workers.values()) {
    if (w.lastHeartbeatAt < deadline && w.status !== "OFFLINE") {
      w.status = "OFFLINE";
      changed = true;

      // mark running tasks failed (simple strategy)
      for (const taskId of w.runningTasks) {
        const t = tasks.get(taskId);
        if (t && t.status === "RUNNING") {
          t.status = "FAILED";
          t.finishedAt = now();
          ringAppendLog(taskId, "Worker offline: task marked FAILED.");
        }
      }
      w.runningTasks.clear();
      w.cpuUsed = 0;
      w.memUsed = 0;
    }
  }

  if (changed) {
    broadcast({ type: "cluster:update", workers: snapshotWorkers() });
    broadcast({ type: "tasks:update", tasks: snapshotTasks() });
  }
}, 2000);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`[master] listening on http://127.0.0.1:${PORT}`);
  console.log(`[master] ws on ws://127.0.0.1:${PORT}`);
});
