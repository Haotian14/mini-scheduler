import test from "node:test";
import assert from "node:assert/strict";

import { createMaster } from "../src/server.js";

const TOKEN = "test-token";

/** Boot a master on an ephemeral port with an in-memory dispatcher. */
async function startMaster(env = {}) {
  const dispatched = [];
  const master = createMaster({
    env: { SCHEDULER_TOKEN: TOKEN, BROADCAST_INTERVAL_MS: "5", ...env },
    dispatcher: {
      dispatch: async (worker, task) => dispatched.push([worker.id, task.id]),
      cancel: async () => {},
    },
    log: () => {},
  });

  const address = await master.start(0);
  const base = `http://127.0.0.1:${address.port}`;

  const call = (path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

  return { master, base, call, dispatched };
}

async function withMaster(env, run) {
  const context = await startMaster(env);
  try {
    await run(context);
  } finally {
    await context.master.stop();
  }
}

test("health is public but the task API is not", async () => {
  await withMaster({}, async ({ base, call }) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const unauthorized = await fetch(`${base}/tasks`);
    assert.equal(unauthorized.status, 401);

    const authorized = await call("/tasks");
    assert.equal(authorized.status, 200);
  });
});

test("a wrong token is rejected", async () => {
  await withMaster({}, async ({ base }) => {
    const response = await fetch(`${base}/tasks`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(response.status, 401);
  });
});

test("CORS echoes only allow-listed origins", async () => {
  await withMaster({ CORS_ORIGIN: "http://localhost:5173" }, async ({ base }) => {
    const allowed = await fetch(`${base}/health`, {
      headers: { origin: "http://localhost:5173" },
    });
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "http://localhost:5173",
    );

    const evil = await fetch(`${base}/health`, {
      headers: { origin: "http://evil.example" },
    });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });
});

test("task submissions are validated", async () => {
  await withMaster({}, async ({ call }) => {
    const cases = [
      [{}, /command/],
      [{ command: "   ", cpu_required: 1, mem_required: 1 }, /command/],
      [{ command: "ls", cpu_required: 0, mem_required: 1 }, /cpu_required/],
      [{ command: "ls", cpu_required: 1, mem_required: -2 }, /mem_required/],
      [{ command: "ls", cpu_required: "1", mem_required: 1 }, /cpu_required/],
    ];

    for (const [body, pattern] of cases) {
      const response = await call("/tasks", { method: "POST", body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match((await response.json()).error, pattern);
    }
  });
});

test("a task submitted with an online worker runs and completes", async () => {
  await withMaster({}, async ({ call, dispatched }) => {
    await call("/workers/register", {
      method: "POST",
      body: { workerId: "w1", host: "127.0.0.1", port: 4001, cpuTotal: 4, memTotal: 8 },
    });

    const created = await call("/tasks", {
      method: "POST",
      body: { command: "echo hello", cpu_required: 1, mem_required: 1 },
    });
    assert.equal(created.status, 201);
    const { taskId } = await created.json();

    // Scheduling is kicked off asynchronously by the request handler.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(dispatched, [["w1", taskId]]);

    const running = await (await call(`/tasks/${taskId}`)).json();
    assert.equal(running.task.status, "RUNNING");
    assert.equal(running.task.assignedWorkerId, "w1");

    await call(`/workers/task/${taskId}/log`, {
      method: "POST",
      body: { workerId: "w1", stream: "stdout", lines: ["hello"] },
    });
    await call(`/workers/task/${taskId}/finish`, {
      method: "POST",
      body: { workerId: "w1", exitCode: 0 },
    });

    const done = await (await call(`/tasks/${taskId}`)).json();
    assert.equal(done.task.status, "SUCCESS");
    assert.equal(done.task.exitCode, 0);

    const { lines } = await (await call(`/tasks/${taskId}/logs`)).json();
    assert.ok(lines.some((line) => line === "[stdout] hello"));

    const workers = await (await call("/workers")).json();
    assert.equal(workers.workers[0].cpuUsed, 0, "capacity is returned after completion");
  });
});

test("a result from a superseded attempt is ignored", async () => {
  await withMaster({}, async ({ call }) => {
    await call("/workers/register", {
      method: "POST",
      body: { workerId: "w1", host: "127.0.0.1", port: 4001, cpuTotal: 4, memTotal: 8 },
    });
    const { taskId } = await (
      await call("/tasks", {
        method: "POST",
        body: { command: "sleep 1", cpu_required: 1, mem_required: 1 },
      })
    ).json();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await call(`/workers/task/${taskId}/finish`, {
      method: "POST",
      body: { workerId: "ghost", exitCode: 0 },
    });

    assert.equal((await response.json()).ignored, "attempt superseded");
    const task = await (await call(`/tasks/${taskId}`)).json();
    assert.equal(task.task.status, "RUNNING");
  });
});

test("a pending task can be cancelled", async () => {
  await withMaster({}, async ({ call }) => {
    const { taskId } = await (
      await call("/tasks", {
        method: "POST",
        body: { command: "echo hi", cpu_required: 1, mem_required: 1 },
      })
    ).json();

    const cancelled = await call(`/tasks/${taskId}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).task.status, "CANCELLED");

    const again = await call(`/tasks/${taskId}/cancel`, { method: "POST" });
    assert.equal(again.status, 409);
  });
});

test("heartbeats from an unknown worker are rejected so it re-registers", async () => {
  await withMaster({}, async ({ call }) => {
    const response = await call("/workers/heartbeat", {
      method: "POST",
      body: { workerId: "ghost", cpuUsed: 0, memUsed: 0, runningTaskIds: [] },
    });
    assert.equal(response.status, 404);
  });
});

test("logs for an unknown task are refused rather than buffered forever", async () => {
  await withMaster({}, async ({ call }) => {
    const response = await call("/workers/task/nope/log", {
      method: "POST",
      body: { stream: "stdout", lines: ["orphan"] },
    });
    assert.equal(response.status, 404);
  });
});
