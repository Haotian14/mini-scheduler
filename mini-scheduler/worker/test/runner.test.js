import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { TaskRunner } from "../src/runner.js";
import { createWorker } from "../src/server.js";

const config = (overrides = {}) =>
  loadConfig({ CPU_TOTAL: "4", MEM_TOTAL: "8", KILL_GRACE_MS: "200", ...overrides });

function makeRunner(overrides = {}) {
  const output = [];
  const exits = [];
  const runner = new TaskRunner(config(overrides), {
    onOutput: (taskId, stream, chunk) => output.push([taskId, stream, chunk.trim()]),
    onExit: (taskId, exitCode) => exits.push([taskId, exitCode]),
  });
  return { runner, output, exits };
}

const waitFor = async (check, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
};

test("a task runs, streams stdout and reports its exit code", async () => {
  const { runner, output, exits } = makeRunner();

  const result = runner.start({
    taskId: "t1",
    command: `node -e "console.log('ok')"`,
    cpuRequired: 1,
    memRequired: 1,
  });
  assert.deepEqual(result, { ok: true });

  await waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [["t1", 0]]);
  assert.ok(output.some(([, stream, chunk]) => stream === "stdout" && chunk === "ok"));
  assert.equal(runner.cpuUsed, 0, "capacity is returned when the process exits");
});

test("a failing command surfaces stderr and a non-zero exit code", async () => {
  const { runner, output, exits } = makeRunner();

  runner.start({
    taskId: "t1",
    command: `node -e "console.error('bad'); process.exit(3)"`,
    cpuRequired: 1,
    memRequired: 1,
  });

  await waitFor(() => exits.length === 1);
  assert.equal(exits[0][1], 3);
  assert.ok(output.some(([, stream, chunk]) => stream === "stderr" && chunk === "bad"));
});

test("work is refused when it would exceed local capacity", () => {
  const { runner } = makeRunner();

  runner.start({ taskId: "t1", command: "sleep 5", cpuRequired: 4, memRequired: 4 });
  const refused = runner.start({
    taskId: "t2",
    command: "sleep 5",
    cpuRequired: 1,
    memRequired: 1,
  });

  assert.equal(refused.error, "insufficient local resources");
  runner.cancelAll();
});

test("the same task cannot be started twice", () => {
  const { runner } = makeRunner();

  runner.start({ taskId: "t1", command: "sleep 5", cpuRequired: 1, memRequired: 1 });
  const duplicate = runner.start({
    taskId: "t1",
    command: "sleep 5",
    cpuRequired: 1,
    memRequired: 1,
  });

  assert.equal(duplicate.error, "task is already running");
  runner.cancelAll();
});

test("cancelling kills the whole process tree, not just the shell", async () => {
  const { runner, exits } = makeRunner();

  // The shell is the direct child; `sleep` is a grandchild. Killing only the
  // shell would leave it running.
  runner.start({
    taskId: "t1",
    command: "sleep 30 & wait",
    cpuRequired: 1,
    memRequired: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(runner.cancel("t1"), true);
  await waitFor(() => exits.length === 1);

  assert.equal(runner.tasks.size, 0);
  assert.equal(runner.cpuUsed, 0);
  assert.equal(runner.cancel("t1"), false, "cancelling an unknown task is a no-op");
});

test("a task that overruns its own time limit is stopped locally", async () => {
  const { runner, exits, output } = makeRunner();

  runner.start({
    taskId: "t1",
    command: "sleep 30",
    cpuRequired: 1,
    memRequired: 1,
    timeoutMs: 100,
  });

  await waitFor(() => exits.length === 1);
  assert.ok(output.some(([, , chunk]) => chunk.includes("Local time limit")));
});

test("/health is public but /run requires the shared token", async (t) => {
  const worker = createWorker({
    env: { SCHEDULER_TOKEN: "tok", WORKER_PORT: "0", MASTER_URL: "http://127.0.0.1:1" },
    log: () => {},
  });
  // Registration fails against a dead master; the worker must still serve.
  const address = await worker.start(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => worker.stop().catch(() => {}));

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).workerId, worker.config.workerId);

  const unauthorized = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId: "t1",
      command: "echo pwned",
      cpuRequired: 1,
      memRequired: 1,
    }),
  });
  assert.equal(
    unauthorized.status,
    401,
    "an unauthenticated /run is remote code execution",
  );

  const badRequest = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify({ taskId: "t1", command: "  ", cpuRequired: 1, memRequired: 1 }),
  });
  assert.equal(badRequest.status, 400);
});
