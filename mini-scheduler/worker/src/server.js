import express from "express";
import http from "node:http";

import { loadConfig } from "./config.js";
import { MasterClient } from "./reporter.js";
import { TaskRunner } from "./runner.js";
import { authMiddleware } from "./auth.js";

/**
 * Assemble a worker: an HTTP surface the master dispatches to, a runner that
 * owns the child processes, and a client that reports back.
 */
export function createWorker({
  env = process.env,
  client,
  spawnImpl,
  log = (...args) => console.log("[worker]", ...args),
} = {}) {
  const config = loadConfig(env);
  const master = client ?? new MasterClient(config);

  const runner = new TaskRunner(config, {
    spawnImpl,
    onOutput: (taskId, stream, chunk) => master.appendLog(taskId, stream, chunk),
    onExit: (taskId, exitCode) => {
      master.finish(taskId, exitCode).catch((error) => {
        // The master's deadline sweeper is the backstop when this never lands.
        log(`failed to report completion of ${taskId}: ${error.message}`);
      });
    },
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      workerId: config.workerId,
      uptime: process.uptime(),
      cpuTotal: config.cpuTotal,
      memTotal: config.memTotal,
      ...runner.usage(),
    });
  });

  app.use(authMiddleware(config.token));

  app.post("/run", (req, res) => {
    const { taskId, command, cpuRequired, memRequired, timeoutMs } = req.body ?? {};

    if (typeof taskId !== "string" || !taskId.trim()) {
      return res.status(400).json({ error: "taskId is required" });
    }
    if (typeof command !== "string" || !command.trim()) {
      return res.status(400).json({ error: "command must be a non-empty string" });
    }
    if (
      !Number.isFinite(cpuRequired) ||
      cpuRequired <= 0 ||
      !Number.isFinite(memRequired) ||
      memRequired <= 0
    ) {
      return res.status(400).json({ error: "invalid resource requirements" });
    }

    const result = runner.start({
      taskId,
      command,
      cpuRequired,
      memRequired,
      timeoutMs,
    });
    if (result.error) return res.status(409).json({ error: result.error });

    log(`running ${taskId}: ${command}`);
    return res.json({ ok: true, workerId: config.workerId });
  });

  app.post("/tasks/:taskId/cancel", (req, res) => {
    const cancelled = runner.cancel(req.params.taskId);
    if (!cancelled) return res.status(404).json({ error: "task not running" });
    log(`cancelling ${req.params.taskId}`);
    return res.json({ ok: true });
  });

  const server = http.createServer(app);
  let heartbeatTimer = null;

  async function heartbeat() {
    try {
      await master.heartbeat(runner.usage());
    } catch (error) {
      // A 404 means the master forgot us (it restarted, or declared us gone),
      // so re-register instead of heartbeating into the void. Anything else is
      // transient: the master marks us OFFLINE and we retry next tick.
      if (String(error?.message).includes("404")) {
        await master.register().catch(() => {});
      }
    }
  }

  return {
    app,
    server,
    config,
    runner,
    master,

    async start(port = config.port) {
      await new Promise((resolve) => server.listen(port, resolve));
      // With port 0 the OS picks one; the master dials us by it, so the
      // registration must advertise the real port, not the requested one.
      const bound = server.address();
      if (bound && typeof bound === "object") config.port = bound.port;

      try {
        await master.register();
        log(`registered with ${config.masterUrl} as ${config.workerId}`);
      } catch (error) {
        log(`registration failed, will retry via heartbeat: ${error.message}`);
      }
      heartbeatTimer = setInterval(() => {
        heartbeat().catch(() => {});
      }, config.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      return server.address();
    },

    /** Stop accepting work, kill children, and tell the master we are gone. */
    async stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      runner.cancelAll();
      await master.deregister().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
