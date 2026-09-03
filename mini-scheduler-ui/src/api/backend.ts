import * as live from "./socket";
import { createTask as liveCreateTask, cancelTask as liveCancelTask } from "./client";
import type { CreateTaskInput } from "./client";
import { DemoCluster } from "../demo/simulator";
import {
  appendLogs,
  removeTask,
  removeWorker,
  replaceSnapshot,
  setLogs,
  store,
  upsertTask,
  upsertWorker,
} from "../store/cluster";

/**
 * The dashboard talks to one of two backends.
 *
 * "live" is a real master over REST + WebSocket. "demo" runs the master's own
 * scheduler modules inside this tab against a simulated fleet, which is what
 * the public GitHub Pages build uses: there is no server to point it at, and
 * exposing one that executes shell commands on the open internet would be a
 * bad idea regardless.
 */
export type BackendKind = "live" | "demo";

export interface SchedulerBackend {
  readonly kind: BackendKind;
  connect(): void;
  createTask(input: CreateTaskInput): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
  subscribeLog(taskId: string): void;
  unsubscribeLog(): void;
  /** Present only in demo mode; drives the "what if" buttons. */
  demo?: DemoCluster;
}

function demoRequested() {
  const forcedByBuild = import.meta.env.VITE_DEMO === "true";
  if (typeof window === "undefined") return forcedByBuild;
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "0") return false;
  return forcedByBuild || params.get("demo") === "1";
}

function createLiveBackend(): SchedulerBackend {
  return {
    kind: "live",
    connect: live.connect,
    createTask: liveCreateTask,
    cancelTask: liveCancelTask,
    subscribeLog: (taskId) => void live.subscribeLog(taskId),
    unsubscribeLog: live.unsubscribeLog,
  };
}

function createDemoBackend(): SchedulerBackend {
  const cluster = new DemoCluster({
    onSnapshot: (workers, tasks) => replaceSnapshot(workers, tasks),
    onWorker: upsertWorker,
    onWorkerRemoved: removeWorker,
    onTask: upsertTask,
    onTaskRemoved: removeTask,
    onLog: (taskId, lines) => appendLogs(taskId, lines),
  });

  return {
    kind: "demo",
    demo: cluster,
    connect() {
      store.connectionStatus = "connected";
      cluster.start();
    },
    createTask: (input) => cluster.createTask(input),
    cancelTask: (taskId) => cluster.cancelTask(taskId),
    subscribeLog(taskId) {
      // Live lines arrive through the state listeners; this fills in history.
      void cluster.getLogs(taskId).then(({ lines }) => setLogs(taskId, lines));
    },
    unsubscribeLog() {},
  };
}

export const backend: SchedulerBackend = demoRequested()
  ? createDemoBackend()
  : createLiveBackend();

export const isDemo = backend.kind === "demo";
