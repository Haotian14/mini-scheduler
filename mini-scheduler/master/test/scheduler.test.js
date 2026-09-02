import test from "node:test";
import assert from "node:assert/strict";

import { planAssignments, fitScore } from "../src/scheduler.js";

const worker = (id, cpuTotal, memTotal, cpuUsed = 0, memUsed = 0, status = "ONLINE") => ({
  id,
  cpuTotal,
  memTotal,
  cpuUsed,
  memUsed,
  status,
});

const task = (id, cpuRequired, memRequired, queuedAt = 0, cooldowns = new Map()) => ({
  id,
  cpuRequired,
  memRequired,
  queuedAt,
  cooldowns,
});

const plan = (workers, tasks, { now = 0, agingMs = 15_000 } = {}) =>
  planAssignments({ workers, tasks, now, agingMs });

test("best-fit prefers the worker left least idle", () => {
  const workers = [worker("big", 8, 16), worker("small", 2, 4)];
  const { assignments } = plan(workers, [task("t1", 2, 4)]);

  assert.deepEqual(assignments, [{ taskId: "t1", workerId: "small" }]);
});

test("fitScore is normalised so capacity is compared proportionally", () => {
  const tight = fitScore(worker("small", 2, 4), task("t", 2, 4));
  const loose = fitScore(worker("big", 8, 16), task("t", 2, 4));

  assert.equal(tight, 0);
  assert.ok(loose > tight);
});

test("offline workers never receive work", () => {
  const workers = [worker("dead", 8, 16, 0, 0, "OFFLINE")];
  const { assignments } = plan(workers, [task("t1", 1, 1)]);

  assert.deepEqual(assignments, []);
});

test("capacity is consumed within a single planning pass", () => {
  const workers = [worker("w", 2, 2)];
  const tasks = [task("t1", 1, 1, 1), task("t2", 1, 1, 2), task("t3", 1, 1, 3)];

  const { assignments } = plan(workers, tasks);

  assert.equal(assignments.length, 2, "the third task must not oversubscribe the worker");
  assert.deepEqual(
    assignments.map((a) => a.taskId),
    ["t1", "t2"],
  );
});

test("a young task may be backfilled ahead of a blocked larger one", () => {
  const workers = [worker("w", 4, 4, 3, 3)];
  const big = task("big", 4, 4, 1000);
  const small = task("small", 1, 1, 2000);

  const { assignments, blockedBy } = plan(workers, [big, small], { now: 5000 });

  assert.deepEqual(assignments, [{ taskId: "small", workerId: "w" }]);
  assert.equal(blockedBy, null);
});

test("once aged, a blocked task becomes a barrier nothing overtakes", () => {
  const workers = [worker("w", 4, 4, 3, 3)];
  const big = task("big", 4, 4, 0);
  const small = task("small", 1, 1, 1000);

  const { assignments, blockedBy } = plan(workers, [big, small], { now: 20_000 });

  assert.deepEqual(assignments, [], "the aged task must not be starved");
  assert.equal(blockedBy, "big");
});

test("a worker on cooldown for a task is skipped, others are still used", () => {
  const workers = [worker("a", 4, 4), worker("b", 4, 4)];
  const cooled = task("t1", 1, 1, 0, new Map([["a", 5000]]));

  const { assignments } = plan(workers, [cooled], { now: 1000 });

  assert.deepEqual(assignments, [{ taskId: "t1", workerId: "b" }]);
});

test("an expired cooldown is ignored", () => {
  const workers = [worker("a", 4, 4)];
  const cooled = task("t1", 1, 1, 0, new Map([["a", 5000]]));

  assert.deepEqual(plan(workers, [cooled], { now: 6000 }).assignments, [
    { taskId: "t1", workerId: "a" },
  ]);
});

test("a task larger than every worker is flagged and never blocks the queue", () => {
  const workers = [worker("w", 4, 4)];
  const huge = task("huge", 64, 64, 0);
  const normal = task("normal", 1, 1, 1000);

  const { assignments, infeasible, blockedBy } = plan(workers, [huge, normal], {
    now: 60_000,
  });

  assert.deepEqual(infeasible, ["huge"]);
  assert.equal(blockedBy, null);
  assert.deepEqual(assignments, [{ taskId: "normal", workerId: "w" }]);
});

test("planning is deterministic for equally good workers", () => {
  const workers = [worker("b", 4, 4), worker("a", 4, 4)];
  const first = plan(workers, [task("t1", 1, 1)]).assignments;
  const second = plan([...workers].reverse(), [task("t1", 1, 1)]).assignments;

  assert.deepEqual(first, second);
});
