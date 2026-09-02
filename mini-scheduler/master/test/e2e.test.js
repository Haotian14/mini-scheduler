import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { createMaster } from "../src/server.js";
import { createWorker } from "../../worker/src/server.js";

const TOKEN = "e2e-token";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the OS for a port, then release it for the process under test. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Poll until `check` returns a truthy value, or fail after `timeoutMs`. */
async function waitFor(
  check,
  { timeoutMs = 10_000, intervalMs = 50, what = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A real master, a real worker and a real WebSocket client, talking over
 * loopback. This is the test that would have caught the reservation race:
 * heartbeats keep arriving while tasks are being dispatched.
 */
test("a task submitted to the master runs on a worker and streams its output", async (t) => {
  const master = createMaster({
    env: {
      SCHEDULER_TOKEN: TOKEN,
      BROADCAST_INTERVAL_MS: "10",
      SWEEP_INTERVAL_MS: "100",
      HEARTBEAT_TIMEOUT_MS: "3000",
    },
    log: () => {},
  });
  const masterAddress = await master.start(0);
  const base = `http://127.0.0.1:${masterAddress.port}`;

  const worker = createWorker({
    env: {
      SCHEDULER_TOKEN: TOKEN,
      MASTER_URL: base,
      WORKER_ID: "e2e-worker",
      WORKER_PORT: "0",
      CPU_TOTAL: "4",
      MEM_TOTAL: "8",
      HEARTBEAT_INTERVAL_MS: "100",
      LOG_FLUSH_INTERVAL_MS: "20",
    },
    log: () => {},
  });
  await worker.start(0);

  t.after(async () => {
    await worker.stop().catch(() => {});
    await master.stop().catch(() => {});
  });

  const call = (path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

  await waitFor(
    async () => (await (await call("/workers")).json()).workers.length === 1,
    { what: "the worker to register" },
  );

  // A dashboard client watching the same events the UI consumes.
  const socket = new WebSocket(`ws://127.0.0.1:${masterAddress.port}/?token=${TOKEN}`);
  const frames = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const { taskId } = await (
    await call("/tasks", {
      method: "POST",
      body: {
        command: `node -e "console.log('hello from task')"`,
        cpu_required: 1,
        mem_required: 1,
      },
    })
  ).json();

  socket.send(JSON.stringify({ type: "subscribeLog", taskId }));

  const finished = await waitFor(
    async () => {
      const { task } = await (await call(`/tasks/${taskId}`)).json();
      return task.status === "SUCCESS" || task.status === "FAILED" ? task : null;
    },
    { what: "the task to finish" },
  );

  assert.equal(finished.status, "SUCCESS");
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.assignedWorkerId, "e2e-worker");
  assert.equal(finished.attempts, 1, "no spurious retries");

  const { lines } = await (await call(`/tasks/${taskId}/logs`)).json();
  assert.ok(
    lines.some((line) => line.includes("hello from task")),
    `stdout was not captured: ${JSON.stringify(lines)}`,
  );

  await waitFor(() => frames.some((frame) => frame.type === "task:log"), {
    what: "a log frame over the WebSocket",
  });
  assert.equal(frames[0].type, "snapshot", "clients get one snapshot, then deltas");
  assert.ok(
    frames.slice(1).every((frame) => frame.type === "batch" || frame.type === "task:log"),
    "no full-state rebroadcast after the snapshot",
  );

  // Capacity accounting survives the whole round trip. The reservation the
  // master owns is dropped the moment the result lands; the usage the worker
  // reports is by definition one heartbeat behind, and `cpuUsed` is the
  // conservative maximum of the two, so it converges rather than snapping.
  const [released] = (await (await call("/workers")).json()).workers;
  assert.equal(released.cpuReserved, 0, "the reservation is released synchronously");
  assert.deepEqual(released.runningTasks, []);

  const converged = await waitFor(
    async () => {
      const [worker] = (await (await call("/workers")).json()).workers;
      return worker.cpuUsed === 0 ? worker : null;
    },
    { what: "reported usage to catch up with the released reservation" },
  );
  assert.equal(converged.memUsed, 0);

  socket.close();
});

test("a worker that crashes is declared offline and its task is re-queued", async (t) => {
  const master = createMaster({
    env: {
      SCHEDULER_TOKEN: TOKEN,
      SWEEP_INTERVAL_MS: "50",
      HEARTBEAT_TIMEOUT_MS: "800",
      BROADCAST_INTERVAL_MS: "10",
    },
    log: () => {},
  });
  const address = await master.start(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await master.stop().catch(() => {});
  });

  const call = (path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

  // A real worker process, so it can be killed without any chance to clean up.
  const workerEntry = fileURLToPath(new URL("../../worker/worker.js", import.meta.url));
  const workerPort = await freePort();
  const child = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      SCHEDULER_TOKEN: TOKEN,
      MASTER_URL: base,
      WORKER_ID: "doomed-worker",
      WORKER_PORT: String(workerPort),
      CPU_TOTAL: "2",
      MEM_TOTAL: "2",
      HEARTBEAT_INTERVAL_MS: "100",
    },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));

  await waitFor(
    async () => (await (await call("/workers")).json()).workers.length === 1,
    {
      what: "the worker process to register",
    },
  );

  const { taskId } = await (
    await call("/tasks", {
      method: "POST",
      body: { command: "sleep 3", cpu_required: 1, mem_required: 1 },
    })
  ).json();

  // Wait until the worker itself confirms the process is running. The master
  // marks a task RUNNING when it commits the reservation, which is a moment
  // earlier, and killing the worker in that window would exercise the
  // dispatch-failure path instead of the one under test.
  await waitFor(
    async () => {
      const health = await fetch(`http://127.0.0.1:${workerPort}/health`).then(
        (response) => response.json(),
        () => null,
      );
      return health?.runningTaskIds?.includes(taskId);
    },
    { what: "the worker to start the process" },
  );

  // SIGKILL: no deregistration, no final report. Only the heartbeat timeout
  // can recover the task.
  child.kill("SIGKILL");

  const requeued = await waitFor(
    async () => {
      const { task } = await (await call(`/tasks/${taskId}`)).json();
      return task.status === "PENDING" ? task : null;
    },
    { what: "the task to return to the queue" },
  );

  assert.equal(requeued.assignedWorkerId, null);

  const { workers } = await (await call("/workers")).json();
  assert.equal(workers[0].status, "OFFLINE");
  assert.equal(workers[0].cpuUsed, 0, "a dead worker holds no capacity");
  assert.deepEqual(workers[0].runningTasks, []);
});
