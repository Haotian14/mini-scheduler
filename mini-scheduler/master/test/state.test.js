import test from "node:test";
import assert from "node:assert/strict";

import { ClusterState } from "../src/state.js";

function makeState(overrides = {}) {
  let now = 1_000;
  const state = new ClusterState({
    taskRetention: 3,
    logRetention: 5,
    clock: () => now,
    ...overrides,
  });
  return {
    state,
    advance(ms) {
      now += ms;
      return now;
    },
  };
}

const register = (state, id = "w1", cpu = 4, mem = 8) =>
  state.registerWorker({
    workerId: id,
    host: "127.0.0.1",
    port: 4001,
    cpuTotal: cpu,
    memTotal: mem,
  });

const submit = (state, cpu = 2, mem = 2, overrides = {}) =>
  state.createTask({
    command: "echo hi",
    cpuRequired: cpu,
    memRequired: mem,
    maxAttempts: 2,
    timeoutMs: 60_000,
    ...overrides,
  });

test("a heartbeat cannot erase a reservation the scheduler just made", () => {
  const { state } = makeState();
  register(state);
  const task = submit(state, 2, 2);

  state.assignTask(task.id, "w1");
  // The worker has not started the process yet, so it still reports zero usage.
  state.applyHeartbeat({ workerId: "w1", cpuUsed: 0, memUsed: 0, runningTaskIds: [] });

  const [view] = state.snapshotWorkers();
  assert.equal(view.cpuUsed, 2, "reserved capacity must survive a stale heartbeat");
  assert.equal(view.memUsed, 2);
  assert.deepEqual(view.runningTasks, [task.id], "the master owns the assignment set");
});

test("a worker reporting more usage than reserved counts the higher number", () => {
  const { state } = makeState();
  register(state);
  submit(state, 1, 1);

  state.applyHeartbeat({
    workerId: "w1",
    cpuUsed: 3,
    memUsed: 6,
    runningTaskIds: ["foreign"],
  });

  const [view] = state.snapshotWorkers();
  assert.equal(view.cpuUsed, 3, "unknown local load still consumes capacity");
  assert.equal(view.memUsed, 6);
});

test("going offline returns running tasks to the queue and frees capacity", () => {
  const { state } = makeState();
  register(state);
  const task = submit(state);
  state.assignTask(task.id, "w1");

  const released = state.markOffline("w1");

  assert.deepEqual(released, [task.id]);
  assert.equal(state.tasks.get(task.id).status, "PENDING");
  assert.equal(state.tasks.get(task.id).assignedWorkerId, null);
  const [view] = state.snapshotWorkers();
  assert.equal(view.cpuUsed, 0);
  assert.equal(view.status, "OFFLINE");
});

test("re-registering an existing worker id releases what it was running", () => {
  const { state } = makeState();
  register(state);
  const task = submit(state);
  state.assignTask(task.id, "w1");

  const { releasedTaskIds } = register(state);

  assert.deepEqual(releasedTaskIds, [task.id]);
  assert.equal(state.tasks.get(task.id).status, "PENDING");
  assert.equal(state.snapshotWorkers()[0].cpuUsed, 0);
});

test("a task fails once it runs out of attempts", () => {
  const { state } = makeState();
  register(state);
  const task = submit(state, 1, 1, { maxAttempts: 2 });

  state.assignTask(task.id, "w1");
  state.requeueTask(task, { failedWorkerId: "w1", error: "boom", cooldownMs: 500 });
  assert.equal(task.status, "PENDING", "one attempt left");
  assert.ok(task.cooldowns.has("w1"), "the failing worker is put on cooldown");

  state.assignTask(task.id, "w1");
  state.requeueTask(task, { failedWorkerId: "w1", error: "boom again" });

  assert.equal(task.status, "FAILED");
  assert.equal(task.attempts, 2);
  assert.equal(task.lastError, "boom again");
});

test("a superseded result cannot resurrect a finished task", () => {
  const { state } = makeState();
  register(state);
  const task = submit(state, 1, 1);
  state.assignTask(task.id, "w1");
  state.finishTask(task.id, { exitCode: 0 });

  assert.equal(state.finishTask(task.id, { exitCode: 1 }), null);
  assert.equal(state.tasks.get(task.id).status, "SUCCESS");
});

test("cancelling frees the reservation and reports the worker to notify", () => {
  const { state } = makeState();
  register(state);
  const task = submit(state, 2, 2);
  state.assignTask(task.id, "w1");

  const result = state.cancelTask(task.id);

  assert.equal(result.workerId, "w1");
  assert.equal(result.task.status, "CANCELLED");
  assert.equal(state.snapshotWorkers()[0].cpuUsed, 0);
  assert.equal(state.cancelTask(task.id), null, "cancelling twice is a no-op");
});

test("terminal tasks are evicted with their logs once retention is exceeded", () => {
  const { state, advance } = makeState();

  for (let index = 0; index < 5; index += 1) {
    const task = submit(state, 1, 1);
    advance(10);
    state.finishTask(task.id, { exitCode: 0 });
  }

  assert.equal(state.tasks.size, 3, "only the newest terminal tasks are kept");
  assert.equal(state.logs.size, 3, "logs are evicted with their task");
});

test("pending and running tasks are never evicted by retention", () => {
  const { state, advance } = makeState();
  register(state);
  const running = submit(state, 1, 1);
  state.assignTask(running.id, "w1");

  for (let index = 0; index < 6; index += 1) {
    const task = submit(state, 1, 1);
    advance(10);
    state.finishTask(task.id, { exitCode: 0 });
  }

  assert.ok(state.tasks.has(running.id));
  assert.equal(state.tasks.get(running.id).status, "RUNNING");
});

test("log buffers are bounded per task", () => {
  const { state } = makeState();
  const task = submit(state);

  for (let index = 0; index < 20; index += 1) state.appendLog(task.id, `line ${index}`);

  const lines = state.getLogs(task.id);
  assert.equal(lines.length, 5);
  assert.equal(lines.at(-1), "line 19", "the newest lines are the ones kept");
});

test("state change listeners fire for workers, tasks and logs", () => {
  const seen = { workers: [], tasks: [], logs: [] };
  const { state } = makeState({
    events: {
      workerChanged: (id) => seen.workers.push(id),
      taskChanged: (id) => seen.tasks.push(id),
      taskLog: (id) => seen.logs.push(id),
    },
  });

  register(state);
  const task = submit(state);

  assert.deepEqual(seen.workers, ["w1"]);
  assert.deepEqual(seen.tasks, [task.id]);
  assert.deepEqual(seen.logs, [task.id]);
});
