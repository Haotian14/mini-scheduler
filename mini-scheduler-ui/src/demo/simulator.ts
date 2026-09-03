import {
  ClusterState,
  type TaskRecord,
  type WorkerRecord,
} from "mini-scheduler-master/state";
import { Scheduler } from "mini-scheduler-master/scheduler";
import { loadConfig, type SchedulerConfig } from "mini-scheduler-master/config";

import {
  DEMO_HISTORY,
  DEMO_LARGE_JOB,
  DEMO_WORKERS,
  pickJob,
  type DemoJob,
} from "./fixtures";
import type { Task, Worker } from "../store/cluster";

/**
 * The demo cluster.
 *
 * This is not a mock of the scheduler: it imports the master's real
 * `ClusterState`, `Scheduler` and `loadConfig` — the same modules the Node
 * service runs — and drives them in the browser. Placement, the reservation
 * ledger, aging, retries, timeouts and offline recovery are therefore the
 * production code paths, exercised live.
 *
 * Only the two things that genuinely need a machine are simulated:
 *
 *   - the HTTP dispatch to a worker, replaced by {@link FakeWorkerRuntime},
 *     which "runs" a process on a timer and reports output and exit codes back
 *     through the same state API a real worker's callbacks would hit;
 *   - the worker heartbeats, emitted here on the same interval a real worker
 *     would use.
 */

const HEARTBEAT_INTERVAL_MS = 2000;
const SCHEDULER_TICK_MS = 500;
const AUTO_SUBMIT_INTERVAL_MS = 9000;
const MAX_AUTO_QUEUED = 4;
const OFFLINE_DURATION_MS = 12_000;

export interface DemoListeners {
  onWorker(worker: Worker): void;
  onWorkerRemoved(workerId: string): void;
  onTask(task: Task): void;
  onTaskRemoved(taskId: string): void;
  onLog(taskId: string, lines: string[]): void;
  onSnapshot(workers: Worker[], tasks: Task[]): void;
}

interface RunningProcess {
  taskId: string;
  workerId: string;
  job: DemoJob;
  startedAt: number;
  nextLineAt: number;
  lineIndex: number;
  endsAt: number;
}

/**
 * Stands in for the worker fleet: holds "processes", emits their output over
 * time, and reports completion. It also owns the usage each worker reports in
 * its heartbeat, so the master still merges two independent views of capacity.
 */
class FakeWorkerRuntime {
  private readonly state: ClusterState;
  private readonly random: () => number;
  private processes = new Map<string, RunningProcess>();
  private offlineUntil = new Map<string, number>();

  constructor(state: ClusterState, random: () => number) {
    this.state = state;
    this.random = random;
  }

  isOffline(workerId: string, now: number) {
    const until = this.offlineUntil.get(workerId);
    return typeof until === "number" && until > now;
  }

  /** Pull a node out of the fleet for a while, killing whatever it was running. */
  takeOffline(workerId: string, now: number, durationMs = OFFLINE_DURATION_MS) {
    this.offlineUntil.set(workerId, now + durationMs);
    for (const [taskId, process] of this.processes) {
      if (process.workerId === workerId) this.processes.delete(taskId);
    }
  }

  recover(workerId: string) {
    this.offlineUntil.delete(workerId);
  }

  usage(workerId: string) {
    let cpuUsed = 0;
    let memUsed = 0;
    const runningTaskIds: string[] = [];

    for (const process of this.processes.values()) {
      if (process.workerId !== workerId) continue;
      const task = this.state.tasks.get(process.taskId);
      if (!task) continue;
      cpuUsed += task.cpuRequired;
      memUsed += task.memRequired;
      runningTaskIds.push(process.taskId);
    }

    return { cpuUsed, memUsed, runningTaskIds };
  }

  /** The dispatch the scheduler calls; rejects exactly like an unreachable node. */
  dispatch(worker: WorkerRecord, task: TaskRecord, job: DemoJob) {
    if (this.isOffline(worker.id, Date.now())) {
      return Promise.reject(new Error("connect ECONNREFUSED"));
    }

    const now = Date.now();
    this.processes.set(task.id, {
      taskId: task.id,
      workerId: worker.id,
      job,
      startedAt: now,
      nextLineAt: now + 400,
      lineIndex: 0,
      endsAt: now + job.durationMs,
    });
    return Promise.resolve();
  }

  cancel(taskId: string) {
    this.processes.delete(taskId);
    return Promise.resolve();
  }

  /** Advance every fake process: emit due output, finish the ones that are done. */
  tick(now: number) {
    for (const [taskId, process] of [...this.processes]) {
      const task = this.state.tasks.get(taskId);
      if (!task || task.status !== "RUNNING") {
        this.processes.delete(taskId);
        continue;
      }

      const { output } = process.job;
      const spacing = process.job.durationMs / (output.length + 1);
      while (process.lineIndex < output.length && now >= process.nextLineAt) {
        this.state.appendLog(taskId, `[stdout] ${output[process.lineIndex]}`);
        process.lineIndex += 1;
        process.nextLineAt += spacing;
      }

      if (now < process.endsAt) continue;

      const failed = this.random() < (process.job.failureRate ?? 0);
      if (failed) {
        this.state.appendLog(taskId, "[stderr] process exited with a non-zero status");
      }
      this.processes.delete(taskId);
      this.state.finishTask(taskId, { exitCode: failed ? 1 : 0 });
    }
  }
}

export class DemoCluster {
  private readonly listeners: DemoListeners;
  private readonly random: () => number;
  private readonly state: ClusterState;
  private readonly scheduler: Scheduler;
  private readonly runtime: FakeWorkerRuntime;
  private readonly config: SchedulerConfig;
  private readonly jobs = new Map<string, DemoJob>();
  private timers: number[] = [];
  private autoSubmit = true;

  constructor(listeners: DemoListeners, random: () => number = Math.random) {
    this.listeners = listeners;
    this.random = random;

    // Timings are compressed relative to the defaults so a visitor sees the
    // interesting behaviour without waiting minutes for it.
    this.config = loadConfig({
      HEARTBEAT_TIMEOUT_MS: "5000",
      SWEEP_INTERVAL_MS: "1000",
      TASK_TIMEOUT_MS: "60000",
      RETRY_COOLDOWN_MS: "6000",
      AGING_MS: "8000",
      MAX_ATTEMPTS: "3",
      TASK_RETENTION: "60",
      LOG_RETENTION: "500",
    });

    this.state = new ClusterState({
      taskRetention: this.config.taskRetention,
      logRetention: this.config.logRetention,
      events: {
        workerChanged: (id) => {
          const worker = this.state.workers.get(id);
          if (worker) this.listeners.onWorker(this.state.workerView(worker));
        },
        workerRemoved: (id) => this.listeners.onWorkerRemoved(id),
        taskChanged: (id) => {
          const task = this.state.tasks.get(id);
          if (task) this.listeners.onTask(this.state.taskView(task));
        },
        taskRemoved: (id) => this.listeners.onTaskRemoved(id),
        taskLog: (taskId, lines) => this.listeners.onLog(taskId, lines),
      },
    });

    this.runtime = new FakeWorkerRuntime(this.state, this.random);

    this.scheduler = new Scheduler({
      state: this.state,
      config: this.config,
      dispatch: (worker, task) =>
        this.runtime.dispatch(worker, task, this.jobFor(task.id)),
      cancel: (_worker, taskId) => this.runtime.cancel(taskId),
      log: () => {},
    });
  }

  private jobFor(taskId: string): DemoJob {
    return this.jobs.get(taskId) ?? { ...pickJob(this.random) };
  }

  start() {
    this.registerWorkers();
    this.seedHistory();

    this.timers.push(
      window.setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS),
      window.setInterval(() => this.tick(), SCHEDULER_TICK_MS),
      window.setInterval(() => this.maybeAutoSubmit(), AUTO_SUBMIT_INTERVAL_MS),
    );

    this.listeners.onSnapshot(this.state.snapshotWorkers(), this.state.snapshotTasks());

    // Give the visitor something moving immediately.
    this.submit(pickJob(this.random));
    this.submit(pickJob(this.random));
    void this.scheduler.schedule();
  }

  stop() {
    this.timers.forEach((timer) => window.clearInterval(timer));
    this.timers = [];
    this.scheduler.stop();
  }

  private registerWorkers() {
    for (const spec of DEMO_WORKERS) {
      this.state.registerWorker({
        workerId: spec.id,
        host: spec.host,
        port: spec.port,
        cpuTotal: spec.cpuTotal,
        memTotal: spec.memTotal,
      });
    }
  }

  /** Backdated finished tasks, so the metric cards are meaningful on load. */
  private seedHistory() {
    const now = Date.now();
    for (const entry of DEMO_HISTORY) {
      const task = this.state.createTask({
        command: entry.job.command,
        cpuRequired: entry.job.cpu,
        memRequired: entry.job.mem,
        maxAttempts: this.config.maxAttempts,
        timeoutMs: this.config.taskTimeoutMs,
      });

      const startedAt = now - entry.startedAgoMs;
      Object.assign(task, {
        status: entry.status,
        assignedWorkerId: entry.workerId,
        attempts: 1,
        createdAt: startedAt - 500,
        queuedAt: startedAt - 500,
        startedAt,
        finishedAt: startedAt + entry.durationMs,
        exitCode: entry.exitCode,
      });

      for (const line of entry.job.output) {
        this.state.appendLog(task.id, `[stdout] ${line}`);
      }
      if (entry.status === "FAILED") {
        this.state.appendLog(task.id, "[stderr] process exited with a non-zero status");
      }
      this.listeners.onTask(this.state.taskView(task));
    }
  }

  private heartbeat() {
    const now = Date.now();
    for (const spec of DEMO_WORKERS) {
      if (this.runtime.isOffline(spec.id, now)) continue;
      // A node that was offline re-registers when it comes back, exactly as a
      // restarted worker process does.
      const worker = this.state.workers.get(spec.id);
      if (!worker || worker.status === "OFFLINE") {
        this.runtime.recover(spec.id);
        this.state.registerWorker({
          workerId: spec.id,
          host: spec.host,
          port: spec.port,
          cpuTotal: spec.cpuTotal,
          memTotal: spec.memTotal,
        });
        continue;
      }
      this.state.applyHeartbeat({ workerId: spec.id, ...this.runtime.usage(spec.id) });
    }
  }

  private tick() {
    this.runtime.tick(Date.now());
    void this.scheduler.sweep();
    void this.scheduler.schedule();
  }

  private maybeAutoSubmit() {
    if (!this.autoSubmit) return;
    const queued = [...this.state.tasks.values()].filter(
      (task) => task.status === "PENDING" || task.status === "RUNNING",
    ).length;
    if (queued >= MAX_AUTO_QUEUED) return;
    this.submit(pickJob(this.random));
  }

  /* --------------------------------------------------------------------- *
   * Public API, mirroring the master's REST surface
   * --------------------------------------------------------------------- */

  private submit(job: DemoJob) {
    const task = this.state.createTask({
      command: job.command,
      cpuRequired: job.cpu,
      memRequired: job.mem,
      maxAttempts: this.config.maxAttempts,
      timeoutMs: this.config.taskTimeoutMs,
    });
    this.jobs.set(task.id, job);
    return task;
  }

  createTask(input: { command: string; cpu_required: number; mem_required: number }) {
    const template = pickJob(this.random);
    const task = this.submit({
      command: input.command,
      cpu: input.cpu_required,
      mem: input.mem_required,
      durationMs: 6000 + Math.floor(this.random() * 6000),
      output: [`$ ${input.command}`, ...template.output.slice(0, 3), "done"],
    });
    void this.scheduler.schedule();
    return Promise.resolve({ taskId: task.id, status: task.status });
  }

  cancelTask(taskId: string) {
    const result = this.state.cancelTask(taskId);
    if (!result) return Promise.reject(new Error("task is not cancellable"));
    void this.runtime.cancel(taskId);
    void this.scheduler.schedule();
    return Promise.resolve({ ok: true });
  }

  getLogs(taskId: string) {
    return Promise.resolve({ lines: [...this.state.getLogs(taskId)] });
  }

  /* --------------------------------------------------------------------- *
   * Demo controls
   * --------------------------------------------------------------------- */

  /** Kill a busy node so its tasks are re-queued, then let it come back. */
  crashWorker() {
    const now = Date.now();
    const candidates = [...this.state.workers.values()].filter(
      (worker) => worker.status === "ONLINE" && !this.runtime.isOffline(worker.id, now),
    );

    const busiest = candidates.sort(
      (a, b) => b.assignedTaskIds.size - a.assignedTaskIds.size,
    )[0];
    if (!busiest) return null;

    this.runtime.takeOffline(busiest.id, now);
    return busiest.id;
  }

  /** Queue a job only the largest node can hold, to show the aging barrier. */
  queueLargeJob() {
    const task = this.submit({ ...DEMO_LARGE_JOB });
    void this.scheduler.schedule();
    return task.id;
  }

  setAutoSubmit(enabled: boolean) {
    this.autoSubmit = enabled;
  }

  get autoSubmitEnabled() {
    return this.autoSubmit;
  }
}
