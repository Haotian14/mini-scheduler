/**
 * Placement policy and the scheduling loop.
 *
 * `planAssignments` is a pure function over plain snapshots: given the workers,
 * the pending queue and the current time it returns the assignments to make.
 * Keeping it free of I/O is what makes the policy directly unit-testable.
 */

/**
 * Normalised best-fit score: the fraction of a worker that would be left idle
 * after placing the task. Lower is tighter, so bin packing prefers the worker
 * that ends up most fully used, which keeps whole workers free for large tasks.
 */
export function fitScore(worker, task) {
  const cpuFree = worker.cpuTotal - worker.cpuUsed;
  const memFree = worker.memTotal - worker.memUsed;
  return (
    (cpuFree - task.cpuRequired) / worker.cpuTotal +
    (memFree - task.memRequired) / worker.memTotal
  );
}

export function fits(worker, task) {
  return (
    worker.cpuTotal - worker.cpuUsed >= task.cpuRequired &&
    worker.memTotal - worker.memUsed >= task.memRequired
  );
}

/** A task is feasible if some online worker could run it when completely idle. */
export function isFeasible(workers, task) {
  return workers.some(
    (worker) =>
      worker.cpuTotal >= task.cpuRequired && worker.memTotal >= task.memRequired,
  );
}

function cooldownActive(task, workerId, now) {
  const until = task.cooldowns?.get?.(workerId);
  return typeof until === "number" && until > now;
}

/**
 * Decide which pending tasks go where.
 *
 * Ordering is FIFO by queue time. A task that cannot be placed is normally
 * skipped so smaller tasks can backfill the gap, but once the oldest waiting
 * task has waited `agingMs` it becomes a barrier and nothing may overtake it.
 * That bounds the wait of a large task by the time it takes for capacity to
 * drain, instead of letting a stream of small tasks starve it forever.
 *
 * @param {object} input
 * @param {Array} input.workers worker views (`cpuUsed` already merged)
 * @param {Array} input.tasks pending tasks
 * @param {number} input.now
 * @param {number} input.agingMs
 * @returns {{assignments: Array<{taskId: string, workerId: string}>,
 *            blockedBy: string|null, infeasible: string[]}}
 */
export function planAssignments({ workers, tasks, now, agingMs }) {
  const online = workers
    .filter((worker) => worker.status === "ONLINE")
    .map((worker) => ({ ...worker }));

  const queue = [...tasks].sort(
    (a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : 1),
  );

  const assignments = [];
  const infeasible = [];
  let blockedBy = null;

  for (const task of queue) {
    if (!isFeasible(online, task)) {
      infeasible.push(task.id);
      continue;
    }

    let best = null;
    let bestScore = Infinity;
    for (const worker of online) {
      if (cooldownActive(task, worker.id, now)) continue;
      if (!fits(worker, task)) continue;
      const score = fitScore(worker, task);
      if (score < bestScore || (score === bestScore && best && worker.id < best.id)) {
        bestScore = score;
        best = worker;
      }
    }

    if (!best) {
      if (now - task.queuedAt >= agingMs) {
        blockedBy = task.id;
        break;
      }
      continue;
    }

    best.cpuUsed += task.cpuRequired;
    best.memUsed += task.memRequired;
    assignments.push({ taskId: task.id, workerId: best.id });
  }

  return { assignments, blockedBy, infeasible };
}

/**
 * Drives the state machine: plans placements, dispatches them, and sweeps for
 * dead workers and overdue tasks. All I/O is injected so the whole loop can be
 * exercised in tests without a network.
 */
export class Scheduler {
  /**
   * @param {object} deps
   * @param {import("./state.js").ClusterState} deps.state
   * @param {object} deps.config
   * @param {(worker: object, task: object) => Promise<void>} deps.dispatch
   * @param {(worker: object, taskId: string) => Promise<void>} [deps.cancel]
   * @param {(...args: any[]) => void} [deps.log]
   */
  constructor({ state, config, dispatch, cancel = async () => {}, log = () => {} }) {
    this.state = state;
    this.config = config;
    this.dispatch = dispatch;
    this.cancel = cancel;
    this.log = log;
    this.reportedInfeasible = new Set();
    this.timer = null;
  }

  /**
   * Plan and dispatch. Assignments are committed to state synchronously so a
   * heartbeat cannot race the reservation; the network call happens after.
   *
   * @returns {Promise<number>} number of tasks dispatched successfully
   */
  async schedule() {
    const { assignments, blockedBy, infeasible } = planAssignments({
      workers: this.state.snapshotWorkers(),
      tasks: this.state.pendingTasks(),
      now: this.state.now(),
      agingMs: this.config.agingMs,
    });

    // Only remember warnings for tasks still in the queue.
    for (const taskId of this.reportedInfeasible) {
      if (this.state.tasks.get(taskId)?.status !== "PENDING") {
        this.reportedInfeasible.delete(taskId);
      }
    }

    for (const taskId of infeasible) {
      if (this.reportedInfeasible.has(taskId)) continue;
      this.reportedInfeasible.add(taskId);
      this.state.appendLog(
        taskId,
        "[system] No online worker is large enough for this task; waiting for capacity",
      );
    }
    if (blockedBy) {
      this.log(`queue barrier: task ${blockedBy} is waiting for capacity`);
    }

    const dispatched = await Promise.all(
      assignments.map(({ taskId, workerId }) => this.commit(taskId, workerId)),
    );
    return dispatched.filter(Boolean).length;
  }

  /**
   * Reserve, then dispatch, rolling the reservation back on failure.
   *
   * The reservation is committed synchronously and the task is marked RUNNING
   * before the network call, so a heartbeat arriving mid-dispatch cannot see
   * capacity that is already spoken for. The cost is a brief window where a
   * task reads as RUNNING while the dispatch is still in flight; a failure in
   * that window rolls everything back and re-queues the task.
   */
  async commit(taskId, workerId) {
    const task = this.state.assignTask(taskId, workerId);
    if (!task) return false;
    const worker = this.state.workers.get(workerId);

    try {
      await this.dispatch(worker, task);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.appendLog(taskId, `[system] Dispatch to ${workerId} failed: ${message}`);
      this.state.requeueTask(task, {
        failedWorkerId: workerId,
        error: `dispatch failed: ${message}`,
        cooldownMs: this.config.retryCooldownMs,
      });
      return false;
    }
  }

  /**
   * Periodic maintenance: declare silent workers offline and stop tasks that
   * overran their deadline. Both paths release capacity and re-run scheduling.
   */
  async sweep() {
    const now = this.state.now();
    let changed = false;

    for (const worker of this.state.workers.values()) {
      const silentFor = now - worker.lastHeartbeatAt;
      if (worker.status === "ONLINE" && silentFor > this.config.heartbeatTimeoutMs) {
        const released = this.state.markOffline(worker.id);
        this.log(
          `worker ${worker.id} offline after ${silentFor}ms; released ${released.length} task(s)`,
        );
        changed = true;
      }
    }

    for (const task of this.state.tasks.values()) {
      if (task.status !== "RUNNING" || !task.deadlineAt) continue;
      if (task.deadlineAt > now) continue;

      const worker = this.state.workers.get(task.assignedWorkerId);
      this.state.appendLog(
        task.id,
        `[system] Attempt exceeded the ${task.timeoutMs}ms time limit`,
      );
      if (worker) {
        this.cancel(worker, task.id).catch(() => {});
      }
      this.state.requeueTask(task, {
        failedWorkerId: task.assignedWorkerId,
        error: "attempt timed out",
        cooldownMs: this.config.retryCooldownMs,
      });
      changed = true;
    }

    if (changed) await this.schedule();
    return changed;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => this.log("sweep failed", error));
    }, this.config.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
