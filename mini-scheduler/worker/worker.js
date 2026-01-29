import express from "express";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

const WORKER_ID =
  process.env.WORKER_ID || `worker_${Math.random().toString(16).slice(2)}`;
const WORKER_HOST = process.env.WORKER_HOST || "127.0.0.1";
const WORKER_PORT = process.env.WORKER_PORT
  ? Number(process.env.WORKER_PORT)
  : 4001;

const MASTER_URL = process.env.MASTER_URL || "http://127.0.0.1:3000";

// demo resource config
const CPU_TOTAL = process.env.CPU_TOTAL ? Number(process.env.CPU_TOTAL) : 4;
const MEM_TOTAL = process.env.MEM_TOTAL ? Number(process.env.MEM_TOTAL) : 8;

// runtime usage (demo: based on assigned tasks sum)
let cpuUsed = 0;
let memUsed = 0;
const runningTasks = new Map(); // taskId -> { cpu, mem, proc }

async function masterPost(path, body) {
  const resp = await fetch(`${MASTER_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Master POST ${path} failed: ${resp.status} ${text}`);
  }
}

async function register() {
  await masterPost("/workers/register", {
    workerId: WORKER_ID,
    host: WORKER_HOST,
    port: WORKER_PORT,
    cpuTotal: CPU_TOTAL,
    memTotal: MEM_TOTAL,
  });
  console.log(`[worker ${WORKER_ID}] registered to ${MASTER_URL}`);
}

async function heartbeat() {
  await masterPost("/workers/heartbeat", {
    workerId: WORKER_ID,
    cpuUsed,
    memUsed,
    runningTaskIds: [...runningTasks.keys()],
  });
}

setInterval(() => {
  heartbeat().catch(() => {
    // ignore transient errors
  });
}, 2000);

/**
 * Receive run request from master
 */
app.post("/run", async (req, res) => {
  const { taskId, command, cpuRequired, memRequired } = req.body || {};
  if (!taskId || !command)
    return res.status(400).json({ error: "missing taskId/command" });

  // simple admission (demo)
  if (cpuUsed + cpuRequired > CPU_TOTAL || memUsed + memRequired > MEM_TOTAL) {
    return res.status(409).json({ error: "insufficient local resources" });
  }

  cpuUsed += cpuRequired;
  memUsed += memRequired;

  const proc = spawn(command, {
    shell: true,
    windowsHide: true,
  });

  runningTasks.set(taskId, { cpu: cpuRequired, mem: memRequired, proc });

  proc.stdout.on("data", (buf) => {
    masterPost(`/workers/task/${taskId}/log`, {
      stream: "stdout",
      chunk: buf.toString(),
    }).catch(() => {});
  });

  proc.stderr.on("data", (buf) => {
    masterPost(`/workers/task/${taskId}/log`, {
      stream: "stderr",
      chunk: buf.toString(),
    }).catch(() => {});
  });

  proc.on("close", (code) => {
    const info = runningTasks.get(taskId);
    if (info) {
      cpuUsed = Math.max(0, cpuUsed - info.cpu);
      memUsed = Math.max(0, memUsed - info.mem);
      runningTasks.delete(taskId);
    }
    masterPost(`/workers/task/${taskId}/finish`, { exitCode: code }).catch(
      () => {},
    );
  });

  return res.json({ ok: true, workerId: WORKER_ID });
});

app.listen(WORKER_PORT, async () => {
  console.log(
    `[worker ${WORKER_ID}] listening on http://${WORKER_HOST}:${WORKER_PORT}`,
  );
  await register().catch((e) => {
    console.error(`[worker ${WORKER_ID}] register failed`, e);
  });
});
