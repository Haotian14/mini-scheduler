import { Router } from "express";

const MAX_COMMAND_LENGTH = 4000;
const MAX_LOG_LINE_LENGTH = 8000;

/** Validate a task submission, returning either an error string or the values. */
export function parseTaskInput(body, { maxAttempts, taskTimeoutMs }) {
  const { command, cpu_required: cpu, mem_required: mem } = body ?? {};

  if (typeof command !== "string" || !command.trim()) {
    return { error: "command must be a non-empty string" };
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    return { error: `command must be at most ${MAX_COMMAND_LENGTH} characters` };
  }
  for (const [name, value] of [
    ["cpu_required", cpu],
    ["mem_required", mem],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `${name} must be a positive number` };
    }
  }

  const attempts = Number(body?.max_attempts);
  const timeout = Number(body?.timeout_ms);

  return {
    value: {
      command: command.trim(),
      cpuRequired: cpu,
      memRequired: mem,
      maxAttempts: Number.isInteger(attempts) && attempts > 0 ? attempts : maxAttempts,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : taskTimeoutMs,
    },
  };
}

function truncate(line) {
  return line.length > MAX_LOG_LINE_LENGTH
    ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}… [truncated]`
    : line;
}

/**
 * Both API surfaces. Worker callbacks and user requests share one token, but
 * they are mounted separately so the two contracts stay readable.
 */
export function createRoutes({ state, scheduler, config, cancelOnWorker }) {
  const router = Router();

  /* ----------------------------- worker API ----------------------------- */

  router.post("/workers/register", (req, res) => {
    const { workerId, host, port, cpuTotal, memTotal } = req.body ?? {};
    if (
      typeof workerId !== "string" ||
      !workerId.trim() ||
      !Number.isFinite(Number(port)) ||
      !Number.isFinite(Number(cpuTotal)) ||
      Number(cpuTotal) <= 0 ||
      !Number.isFinite(Number(memTotal)) ||
      Number(memTotal) <= 0
    ) {
      return res.status(400).json({ error: "invalid worker registration" });
    }

    const { releasedTaskIds } = state.registerWorker({
      workerId: workerId.trim(),
      host,
      port: Number(port),
      cpuTotal: Number(cpuTotal),
      memTotal: Number(memTotal),
    });

    scheduler.schedule().catch(() => {});
    return res.json({
      ok: true,
      heartbeatIntervalMs: Math.floor(config.heartbeatTimeoutMs / 3),
      releasedTaskIds,
    });
  });

  router.post("/workers/heartbeat", (req, res) => {
    const { workerId, cpuUsed, memUsed, runningTaskIds } = req.body ?? {};
    const known = state.applyHeartbeat({
      workerId,
      cpuUsed: Number(cpuUsed),
      memUsed: Number(memUsed),
      runningTaskIds,
    });
    if (!known) return res.status(404).json({ error: "worker not registered" });

    scheduler.schedule().catch(() => {});
    return res.json({ ok: true });
  });

  router.post("/workers/deregister", (req, res) => {
    const { workerId } = req.body ?? {};
    const released = state.removeWorker(workerId);
    scheduler.schedule().catch(() => {});
    return res.json({ ok: true, releasedTaskIds: released });
  });

  router.post("/workers/task/:taskId/log", (req, res) => {
    const { taskId } = req.params;
    if (!state.tasks.has(taskId)) {
      return res.status(404).json({ error: "task not found" });
    }

    // Workers batch their output, but a single `chunk` is still accepted.
    const stream = req.body?.stream === "stderr" ? "stderr" : "stdout";
    const incoming = Array.isArray(req.body?.lines) ? req.body.lines : [req.body?.chunk];

    const lines = incoming
      .filter((line) => typeof line === "string" && line.length)
      .flatMap((line) => line.replace(/\r\n/g, "\n").split("\n"))
      .filter((line) => line.length)
      .map((line) => truncate(`[${stream}] ${line}`));

    state.appendLog(taskId, lines);
    return res.json({ ok: true, accepted: lines.length });
  });

  router.post("/workers/task/:taskId/finish", (req, res) => {
    const { taskId } = req.params;
    const exitCode = Number(req.body?.exitCode);
    const task = state.tasks.get(taskId);
    if (!task) return res.status(404).json({ error: "task not found" });

    // A worker may report an attempt the master already re-queued elsewhere;
    // that result belongs to a superseded attempt and must not overwrite state.
    const reporter = req.body?.workerId;
    if (reporter && task.assignedWorkerId && task.assignedWorkerId !== reporter) {
      return res.json({ ok: true, ignored: "attempt superseded" });
    }

    const finished = state.finishTask(taskId, {
      exitCode: Number.isFinite(exitCode) ? exitCode : -1,
    });
    if (!finished) return res.json({ ok: true, ignored: "task already final" });

    scheduler.schedule().catch(() => {});
    return res.json({ ok: true });
  });

  /* ------------------------------ user API ------------------------------ */

  router.post("/tasks", (req, res) => {
    const { error, value } = parseTaskInput(req.body, config);
    if (error) return res.status(400).json({ error });

    const task = state.createTask(value);
    scheduler.schedule().catch(() => {});
    return res.status(201).json({ taskId: task.id, status: task.status });
  });

  router.get("/tasks", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const tasks = state
      .snapshotTasks()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    return res.json({ tasks });
  });

  router.get("/tasks/:taskId", (req, res) => {
    const task = state.tasks.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: "task not found" });
    return res.json({ task: state.taskView(task) });
  });

  router.get("/tasks/:taskId/logs", (req, res) => {
    if (!state.tasks.has(req.params.taskId)) {
      return res.status(404).json({ error: "task not found" });
    }
    return res.json({ lines: state.getLogs(req.params.taskId) });
  });

  router.post("/tasks/:taskId/cancel", async (req, res) => {
    const result = state.cancelTask(req.params.taskId);
    if (!result) {
      return res.status(409).json({ error: "task is not cancellable" });
    }
    if (result.workerId) {
      const worker = state.workers.get(result.workerId);
      if (worker) await cancelOnWorker(worker, result.task.id).catch(() => {});
    }
    scheduler.schedule().catch(() => {});
    return res.json({ ok: true, task: state.taskView(result.task) });
  });

  router.get("/workers", (_req, res) => {
    return res.json({ workers: state.snapshotWorkers() });
  });

  return router;
}
