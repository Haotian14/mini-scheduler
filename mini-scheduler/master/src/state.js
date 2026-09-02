/**
 * In-memory cluster state: workers, tasks and task logs.
 *
 * Resource accounting keeps two independent numbers per worker:
 *
 *   - `cpuReserved` / `memReserved` — what the master has committed to tasks it
 *     assigned. The master owns these, so they are correct the instant a task is
 *     scheduled, before the worker has even received the dispatch.
 *   - `cpuReported` / `memReported` — what the worker last said it was using.
 *
 * The effective usage is `max(reserved, reported)`. Taking the maximum is what
 * makes the two sources safe to combine: a heartbeat that arrives between the
 * reservation and the worker actually starting the process can no longer erase
 * the reservation and cause the same capacity to be handed out twice, and a
 * worker running something the master does not know about still counts against
 * capacity. Both sources converge within one heartbeat interval.
 *
 * The same rule applies to the running-task set: `assignedTaskIds` is owned by
 * the master and drives requeueing when a worker dies. `reportedTaskIds` is
 * only what the worker claims, and is used for observability and reconciliation.
 */

export const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

const noopEvents = {
  workerChanged() {},
  workerRemoved() {},
  taskChanged() {},
  taskRemoved() {},
  taskLog() {},
};

export class ClusterState {
  /**
   * @param {object} options
   * @param {number} options.taskRetention terminal tasks kept in memory
   * @param {number} options.logRetention log lines kept per task
   * @param {() => number} [options.clock] injectable time source (tests)
   * @param {object} [options.events] change notifications
   */
  constructor({ taskRetention, logRetention, clock = Date.now, events } = {}) {
    this.taskRetention = taskRetention ?? 500;
    this.logRetention = logRetention ?? 5000;
    this.clock = clock;
    this.events = { ...noopEvents, ...events };

    /** @type {Map<string, object>} */
    this.workers = new Map();
    /** @type {Map<string, object>} */
    this.tasks = new Map();
    /** @type {Map<string, string[]>} */
    this.logs = new Map();
    this.sequence = 0;
  }

  now() {
    return this.clock();
  }

  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}_${this.now().toString(36)}_${this.sequence.toString(36)}`;
  }

  /* ------------------------------------------------------------------ *
   * Workers
   * ------------------------------------------------------------------ */

  /**
   * Register a worker. Re-registering an existing id is treated as a restart:
   * anything the master believed was running there is released, because the
   * worker's process table is now empty.
   *
   * @returns {{worker: object, releasedTaskIds: string[]}}
   */
  registerWorker({ workerId, host, port, cpuTotal, memTotal }) {
    const releasedTaskIds = this.workers.has(workerId)
      ? this.releaseWorkerTasks(workerId)
      : [];

    const worker = {
      id: workerId,
      host: host || "127.0.0.1",
      port,
      cpuTotal,
      memTotal,
      cpuReserved: 0,
      memReserved: 0,
      cpuReported: 0,
      memReported: 0,
      assignedTaskIds: new Set(),
      reportedTaskIds: new Set(),
      status: "ONLINE",
      registeredAt: this.now(),
      lastHeartbeatAt: this.now(),
    };

    this.workers.set(workerId, worker);
    this.events.workerChanged(workerId);
    return { worker, releasedTaskIds };
  }

  /**
   * Apply a heartbeat. Reported usage never clobbers the master's reservations;
   * see the note at the top of this file.
   *
   * @returns {boolean} whether the worker is known
   */
  applyHeartbeat({ workerId, cpuUsed, memUsed, runningTaskIds }) {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    worker.lastHeartbeatAt = this.now();
    worker.status = "ONLINE";
    if (Number.isFinite(cpuUsed)) worker.cpuReported = Math.max(0, cpuUsed);
    if (Number.isFinite(memUsed)) worker.memReported = Math.max(0, memUsed);
    if (Array.isArray(runningTaskIds)) {
      worker.reportedTaskIds = new Set(runningTaskIds);
    }

    this.events.workerChanged(workerId);
    return true;
  }

  /**
   * Move a worker to OFFLINE and hand its tasks back to the queue.
   *
   * @returns {string[]} ids of the tasks that returned to PENDING
   */
  markOffline(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker || worker.status === "OFFLINE") return [];

    worker.status = "OFFLINE";
    const releasedTaskIds = this.releaseWorkerTasks(workerId, {
      reason: "Worker went offline; task returned to the queue",
    });
    this.events.workerChanged(workerId);
    return releasedTaskIds;
  }

  /**
   * Detach every task the master assigned to a worker and reset its usage.
   * Tasks that still have attempts left go back to PENDING; the rest fail.
   */
  releaseWorkerTasks(workerId, { reason = "Worker became unavailable" } = {}) {
    const worker = this.workers.get(workerId);
    if (!worker) return [];

    const released = [];
    for (const taskId of [...worker.assignedTaskIds]) {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "RUNNING") continue;
      this.appendLog(taskId, `[system] ${reason}`);
      this.requeueTask(task, { failedWorkerId: workerId, error: reason });
      released.push(taskId);
    }

    worker.assignedTaskIds.clear();
    worker.reportedTaskIds.clear();
    worker.cpuReserved = 0;
    worker.memReserved = 0;
    worker.cpuReported = 0;
    worker.memReported = 0;
    return released;
  }

  removeWorker(workerId) {
    const released = this.releaseWorkerTasks(workerId, {
      reason: "Worker deregistered",
    });
    if (this.workers.delete(workerId)) this.events.workerRemoved(workerId);
    return released;
  }

  /** Effective usage of a worker: the safe merge of reserved and reported. */
  static usage(worker) {
    return {
      cpu: Math.max(worker.cpuReserved, worker.cpuReported),
      mem: Math.max(worker.memReserved, worker.memReported),
    };
  }

  workerView(worker) {
    const used = ClusterState.usage(worker);
    return {
      id: worker.id,
      host: worker.host,
      port: worker.port,
      cpuTotal: worker.cpuTotal,
      memTotal: worker.memTotal,
      cpuUsed: used.cpu,
      memUsed: used.mem,
      cpuReserved: worker.cpuReserved,
      memReserved: worker.memReserved,
      status: worker.status,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      runningTasks: [...worker.assignedTaskIds],
    };
  }

  snapshotWorkers() {
    return [...this.workers.values()].map((worker) => this.workerView(worker));
  }

  /* ------------------------------------------------------------------ *
   * Tasks
   * ------------------------------------------------------------------ */

  createTask({ command, cpuRequired, memRequired, maxAttempts, timeoutMs }) {
    const task = {
      id: this.nextId("task"),
      command,
      cpuRequired,
      memRequired,
      status: "PENDING",
      assignedWorkerId: null,
      attempts: 0,
      maxAttempts,
      timeoutMs,
      createdAt: this.now(),
      queuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      deadlineAt: null,
      exitCode: null,
      lastError: null,
      /** workerId -> timestamp until which the worker is skipped for this task */
      cooldowns: new Map(),
    };

    this.tasks.set(task.id, task);
    this.appendLog(task.id, `[system] Task created: ${command}`);
    this.events.taskChanged(task.id);
    return task;
  }

  /** Commit a task to a worker and reserve its resources. */
  assignTask(taskId, workerId) {
    const task = this.tasks.get(taskId);
    const worker = this.workers.get(workerId);
    if (!task || !worker || task.status !== "PENDING") return null;

    task.status = "RUNNING";
    task.assignedWorkerId = workerId;
    task.attempts += 1;
    task.startedAt = this.now();
    task.deadlineAt = this.now() + task.timeoutMs;

    worker.cpuReserved += task.cpuRequired;
    worker.memReserved += task.memRequired;
    worker.assignedTaskIds.add(taskId);

    this.events.taskChanged(taskId);
    this.events.workerChanged(workerId);
    return task;
  }

  /** Drop a task's reservation on its worker without changing task status. */
  releaseReservation(task) {
    const worker = this.workers.get(task.assignedWorkerId);
    if (!worker) return;
    worker.cpuReserved = Math.max(0, worker.cpuReserved - task.cpuRequired);
    worker.memReserved = Math.max(0, worker.memReserved - task.memRequired);
    worker.assignedTaskIds.delete(task.id);
    this.events.workerChanged(worker.id);
  }

  /**
   * Send a task back to the queue, or fail it when it is out of attempts.
   * The worker that just failed it is put on cooldown so the next attempt
   * prefers a different node.
   */
  requeueTask(task, { failedWorkerId = null, error = null, cooldownMs = 0 } = {}) {
    this.releaseReservation(task);

    if (failedWorkerId && cooldownMs > 0) {
      task.cooldowns.set(failedWorkerId, this.now() + cooldownMs);
    }

    task.assignedWorkerId = null;
    task.startedAt = null;
    task.deadlineAt = null;
    task.lastError = error;

    if (task.attempts >= task.maxAttempts) {
      task.status = "FAILED";
      task.finishedAt = this.now();
      task.exitCode = task.exitCode ?? -1;
      this.appendLog(
        task.id,
        `[system] Giving up after ${task.attempts} attempt(s): ${error ?? "unknown error"}`,
      );
    } else {
      task.status = "PENDING";
      task.queuedAt = this.now();
      this.appendLog(
        task.id,
        `[system] Re-queued (attempt ${task.attempts}/${task.maxAttempts})`,
      );
    }

    this.events.taskChanged(task.id);
    this.pruneTasks();
    return task;
  }

  /** Record a terminal outcome reported by a worker. */
  finishTask(taskId, { exitCode, status }) {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return null;

    this.releaseReservation(task);
    task.finishedAt = this.now();
    task.exitCode = exitCode ?? null;
    task.status = status ?? (exitCode === 0 ? "SUCCESS" : "FAILED");
    task.assignedWorkerId = task.assignedWorkerId ?? null;
    task.deadlineAt = null;

    this.events.taskChanged(taskId);
    this.pruneTasks();
    return task;
  }

  /** Cancel a pending or running task. */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return null;

    const workerId = task.assignedWorkerId;
    this.releaseReservation(task);
    task.status = "CANCELLED";
    task.finishedAt = this.now();
    task.deadlineAt = null;
    this.appendLog(taskId, "[system] Task cancelled by user");
    this.events.taskChanged(taskId);
    this.pruneTasks();
    return { task, workerId };
  }

  /** The public shape of a task: internal scheduling bookkeeping is stripped. */
  taskView(task) {
    // eslint-disable-next-line no-unused-vars
    const { cooldowns, ...view } = task;
    return view;
  }

  snapshotTasks() {
    return [...this.tasks.values()].map((task) => this.taskView(task));
  }

  pendingTasks() {
    return [...this.tasks.values()].filter((task) => task.status === "PENDING");
  }

  /**
   * Evict the oldest terminal tasks (and their logs) once the retention limit
   * is exceeded. Pending and running tasks are never evicted.
   */
  pruneTasks() {
    const terminal = [...this.tasks.values()].filter((task) =>
      TERMINAL_STATUSES.has(task.status),
    );
    const excess = terminal.length - this.taskRetention;
    if (excess <= 0) return;

    terminal
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      .slice(0, excess)
      .forEach((task) => {
        this.tasks.delete(task.id);
        this.logs.delete(task.id);
        this.events.taskRemoved(task.id);
      });
  }

  /* ------------------------------------------------------------------ *
   * Logs
   * ------------------------------------------------------------------ */

  appendLog(taskId, ...lines) {
    const flat = lines.flat().filter((line) => typeof line === "string");
    if (!flat.length) return [];

    const buffer = this.logs.get(taskId) ?? [];
    buffer.push(...flat);
    if (buffer.length > this.logRetention) {
      buffer.splice(0, buffer.length - this.logRetention);
    }
    this.logs.set(taskId, buffer);
    this.events.taskLog(taskId, flat);
    return flat;
  }

  getLogs(taskId) {
    return this.logs.get(taskId) ?? [];
  }

  stats() {
    const byStatus = {};
    for (const task of this.tasks.values()) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    }
    return {
      workers: this.workers.size,
      onlineWorkers: [...this.workers.values()].filter(
        (worker) => worker.status === "ONLINE",
      ).length,
      tasks: this.tasks.size,
      tasksByStatus: byStatus,
      bufferedLogTasks: this.logs.size,
    };
  }
}
