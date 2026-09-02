import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";

import { loadConfig } from "./config.js";
import { ClusterState } from "./state.js";
import { Scheduler } from "./scheduler.js";
import { EventHub } from "./events.js";
import { createDispatcher } from "./dispatcher.js";
import { createRoutes } from "./http/routes.js";
import {
  authMiddleware,
  corsMiddleware,
  isAuthorizedUpgrade,
} from "./http/middleware.js";

/**
 * Assemble the master. Every collaborator is injectable so tests can run the
 * real HTTP surface against a fake dispatcher and a controllable clock.
 *
 * @param {object} [options]
 * @param {object} [options.env] environment used for configuration
 * @param {object} [options.dispatcher] `{dispatch, cancel}` transport override
 * @param {() => number} [options.clock]
 * @param {(...args: any[]) => void} [options.log]
 */
export function createMaster({
  env = process.env,
  dispatcher,
  clock = Date.now,
  log = (...args) => console.log("[master]", ...args),
} = {}) {
  const config = loadConfig(env);
  const transport = dispatcher ?? createDispatcher({ token: config.token });

  const hub = new EventHub({
    state: null,
    intervalMs: config.broadcastIntervalMs,
    clock,
  });
  const state = new ClusterState({
    taskRetention: config.taskRetention,
    logRetention: config.logRetention,
    clock,
    events: hub.listeners(),
  });
  hub.state = state;

  const scheduler = new Scheduler({
    state,
    config,
    dispatch: (worker, task) => transport.dispatch(worker, task),
    cancel: (worker, taskId) => transport.cancel(worker, taskId),
    log,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(corsMiddleware(config.corsOrigins));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), ...state.stats() });
  });

  app.use(
    authMiddleware(config.token),
    createRoutes({
      state,
      scheduler,
      config,
      cancelOnWorker: (worker, taskId) => transport.cancel(worker, taskId),
    }),
  );

  app.use((error, _req, res, _next) => {
    log("unhandled request error", error);
    res.status(500).json({ error: "internal error" });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (!isAuthorizedUpgrade(request, config.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    hub.addClient(ws);
    ws.on("message", (raw) => hub.handleClientMessage(ws, raw));
    ws.on("close", () => hub.removeClient(ws));
    ws.on("error", () => hub.removeClient(ws));
  });

  return {
    app,
    server,
    config,
    state,
    scheduler,
    hub,

    async start(port = config.port) {
      await new Promise((resolve) => server.listen(port, resolve));
      scheduler.start();
      return server.address();
    },

    async stop() {
      scheduler.stop();
      hub.close();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
