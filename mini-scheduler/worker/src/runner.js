import { spawn } from "node:child_process";

/**
 * Local execution and resource bookkeeping.
 *
 * Commands run through a shell, which means the child of this process is the
 * shell itself. Killing only that leaves grandchildren orphaned, so on POSIX
 * the task runs in its own process group and cancellation signals the whole
 * group. Windows falls back to `taskkill /T`.
 */
export class TaskRunner {
  /**
   * @param {object} config
   * @param {object} deps
   * @param {typeof spawn} [deps.spawnImpl]
   * @param {(taskId: string, stream: string, chunk: string) => void} deps.onOutput
   * @param {(taskId: string, exitCode: number) => void} deps.onExit
   */
  constructor(config, { spawnImpl = spawn, onOutput, onExit }) {
    this.config = config;
    this.spawnImpl = spawnImpl;
    this.onOutput = onOutput;
    this.onExit = onExit;

    this.cpuUsed = 0;
    this.memUsed = 0;
    /** @type {Map<string, {cpu: number, mem: number, proc: any, timer: any, cancelled: boolean}>} */
    this.tasks = new Map();
  }

  get runningTaskIds() {
    return [...this.tasks.keys()];
  }

  usage() {
    return {
      cpuUsed: this.cpuUsed,
      memUsed: this.memUsed,
      runningTaskIds: this.runningTaskIds,
    };
  }

  hasCapacity(cpu, mem) {
    return (
      this.cpuUsed + cpu <= this.config.cpuTotal &&
      this.memUsed + mem <= this.config.memTotal
    );
  }

  /**
   * Start a task. Returns `{error}` instead of throwing so the HTTP layer can
   * map refusals to the right status code.
   */
  start({ taskId, command, cpuRequired, memRequired, timeoutMs }) {
    if (this.tasks.has(taskId)) return { error: "task is already running" };
    if (!this.hasCapacity(cpuRequired, memRequired)) {
      return { error: "insufficient local resources" };
    }

    this.cpuUsed += cpuRequired;
    this.memUsed += memRequired;

    const proc = this.spawnImpl(command, {
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const entry = {
      cpu: cpuRequired,
      mem: memRequired,
      proc,
      timer: null,
      cancelled: false,
    };
    this.tasks.set(taskId, entry);

    proc.stdout?.on("data", (buf) => this.onOutput(taskId, "stdout", buf.toString()));
    proc.stderr?.on("data", (buf) => this.onOutput(taskId, "stderr", buf.toString()));
    proc.on("error", (error) => this.onOutput(taskId, "stderr", error.message));

    proc.on("close", (code, signal) => {
      this.release(taskId);
      const exitCode = code === null ? 128 + (signal === "SIGKILL" ? 9 : 15) : code;
      this.onExit(taskId, exitCode);
    });

    // The master owns the authoritative deadline; this is a local backstop in
    // case the master becomes unreachable while the task keeps running.
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.onOutput(taskId, "stderr", `Local time limit of ${timeoutMs}ms reached`);
        this.cancel(taskId);
      }, timeoutMs);
      entry.timer.unref?.();
    }

    return { ok: true };
  }

  release(taskId) {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.cpuUsed = Math.max(0, this.cpuUsed - entry.cpu);
    this.memUsed = Math.max(0, this.memUsed - entry.mem);
    this.tasks.delete(taskId);
  }

  /** SIGTERM the process group, then SIGKILL it if it is still alive. */
  cancel(taskId) {
    const entry = this.tasks.get(taskId);
    if (!entry) return false;
    entry.cancelled = true;

    this.signal(entry.proc, "SIGTERM");
    const escalation = setTimeout(() => {
      if (this.tasks.has(taskId)) this.signal(entry.proc, "SIGKILL");
    }, this.config.killGraceMs);
    escalation.unref?.();
    return true;
  }

  signal(proc, signal) {
    if (!proc.pid || proc.killed) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
      } else {
        process.kill(-proc.pid, signal);
      }
    } catch {
      // The group is already gone; the close handler will clean up.
      try {
        proc.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }

  cancelAll() {
    for (const taskId of this.runningTaskIds) this.cancel(taskId);
  }
}
