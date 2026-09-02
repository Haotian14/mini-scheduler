import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { ClusterState } from "../src/state.js";
import { Scheduler } from "../src/scheduler.js";

/** A scheduler wired to an in-memory dispatcher and a clock the test controls. */
function harness({ dispatch, env = {} } = {}) {
  let now = 1_000;
  const config = loadConfig({
    AGING_MS: "15000",
    RETRY_COOLDOWN_MS: "5000",
    HEARTBEAT_TIMEOUT_MS: "6000",
    TASK_TIMEOUT_MS: "10000",
    MAX_ATTEMPTS: "3",
    ...env,
  });
  const state = new ClusterState({
    taskRetention: config.taskRetention,
    logRetention: config.logRetention,
    clock: () => now,
  });
  const cancelled = [];
  const scheduler = new Scheduler({
    state,
    config,
    dispatch: dispatch ?? (async () => {}),
    cancel: async (worker, taskId) => cancelled.push([worker.id, taskId]),
  });

  return {
    state,
    scheduler,
    config,
    cancelled,
    advance: (ms) => {
      now += ms;
    },
    addWorker: (id, cpu = 4, mem = 8) =>
      state.registerWorker({
        workerId: id,
        host: "127.0.0.1",
        port: 4001,
        cpuTotal: cpu,
        memTotal: mem,
      }),
    heartbeat: (id) =>
      state.applyHeartbeat({ workerId: id, cpuUsed: 0, memUsed: 0, runningTaskIds: [] }),
    submit: (cpu = 1, mem = 1) =>
      state.createTask({
        command: "true",
        cpuRequired: cpu,
        memRequired: mem,
        maxAttempts: config.maxAttempts,
        timeoutMs: config.taskTimeoutMs,
      }),
  };
}

test("a scheduled task is dispatched exactly once", async () => {
  const dispatched = [];
  const h = harness({
    dispatch: async (worker, task) => dispatched.push([worker.id, task.id]),
  });
  h.addWorker("w1");
  const task = h.submit();

  await h.scheduler.schedule();
  await h.scheduler.schedule();

  assert.equal(dispatched.length, 1);
  assert.equal(h.state.tasks.get(task.id).status, "RUNNING");
});

test("a failed dispatch rolls back the reservation and retries elsewhere", async () => {
  const attempts = [];
  const h = harness({
    dispatch: async (worker) => {
      attempts.push(worker.id);
      if (worker.id === "bad") throw new Error("connection refused");
    },
  });
  // Best-fit prefers the tighter node, so "bad" is tried first.
  h.addWorker("bad", 2, 2);
  h.addWorker("good", 8, 8);
  const task = h.submit(1, 1);

  await h.scheduler.schedule();
  assert.equal(attempts[0], "bad");
  assert.equal(h.state.tasks.get(task.id).status, "PENDING");
  assert.equal(h.state.snapshotWorkers().find((w) => w.id === "bad").cpuUsed, 0);

  await h.scheduler.schedule();
  assert.deepEqual(
    attempts,
    ["bad", "good"],
    "the failing worker is skipped while on cooldown",
  );
  assert.equal(h.state.tasks.get(task.id).status, "RUNNING");
});

test("a silent worker is declared offline and its task is rescheduled", async () => {
  const dispatched = [];
  const h = harness({
    dispatch: async (worker, task) => dispatched.push([worker.id, task.id]),
  });
  h.addWorker("w1");
  const task = h.submit();
  await h.scheduler.schedule();

  h.addWorker("w2");
  h.advance(7000);
  h.heartbeat("w2");
  await h.scheduler.sweep();

  assert.equal(h.state.workers.get("w1").status, "OFFLINE");
  assert.equal(h.state.tasks.get(task.id).status, "RUNNING");
  assert.equal(h.state.tasks.get(task.id).assignedWorkerId, "w2");
  assert.deepEqual(
    dispatched.map(([workerId]) => workerId),
    ["w1", "w2"],
  );
});

test("an overdue task is cancelled on its worker and retried", async () => {
  const h = harness();
  h.addWorker("w1");
  const task = h.submit();
  await h.scheduler.schedule();

  h.advance(11_000);
  h.heartbeat("w1");
  await h.scheduler.sweep();

  assert.deepEqual(
    h.cancelled,
    [["w1", task.id]],
    "the worker is told to stop the process",
  );
  assert.equal(h.state.tasks.get(task.id).status, "PENDING");
  assert.equal(h.state.tasks.get(task.id).attempts, 1);
  assert.match(h.state.getLogs(task.id).join("\n"), /time limit/);
  assert.equal(
    h.state.snapshotWorkers()[0].cpuUsed,
    0,
    "the timed-out attempt must not leak capacity",
  );

  // The node that just timed the task out is on cooldown; once it expires the
  // task is retried there.
  await h.scheduler.schedule();
  assert.equal(h.state.tasks.get(task.id).status, "PENDING", "still cooling down");
  h.advance(6000);
  await h.scheduler.schedule();
  assert.equal(h.state.tasks.get(task.id).attempts, 2);
});

test("a task that keeps timing out eventually fails instead of looping", async () => {
  const h = harness({ env: { MAX_ATTEMPTS: "2" } });
  h.addWorker("w1");
  const task = h.submit();

  for (let round = 0; round < 3; round += 1) {
    await h.scheduler.schedule();
    h.advance(11_000);
    h.heartbeat("w1");
    await h.scheduler.sweep();
  }

  assert.equal(h.state.tasks.get(task.id).status, "FAILED");
  assert.equal(h.state.tasks.get(task.id).attempts, 2);
});

test("an unschedulable task is explained once, not on every pass", async () => {
  const h = harness();
  h.addWorker("w1", 2, 2);
  const task = h.submit(64, 64);

  await h.scheduler.schedule();
  await h.scheduler.schedule();

  const warnings = h.state
    .getLogs(task.id)
    .filter((line) => line.includes("large enough"));
  assert.equal(warnings.length, 1);
  assert.equal(h.state.tasks.get(task.id).status, "PENDING");
});

test("configuration refuses to start unauthenticated in production", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /SCHEDULER_TOKEN/);
  assert.doesNotThrow(() =>
    loadConfig({ NODE_ENV: "production", SCHEDULER_TOKEN: "s3cret" }),
  );
});

test("CORS defaults to the dev origin rather than a wildcard", () => {
  assert.deepEqual(loadConfig({}).corsOrigins, [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
});
