import { computed, reactive } from "vue";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type TaskStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
export type WorkerStatus = "ONLINE" | "OFFLINE";

export interface Worker {
  id: string;
  host: string;
  port: number;
  cpuTotal: number;
  memTotal: number;
  cpuUsed: number;
  memUsed: number;
  cpuReserved: number;
  memReserved: number;
  status: WorkerStatus;
  lastHeartbeatAt: number;
  runningTasks: string[];
}

export interface Task {
  id: string;
  command: string;
  cpuRequired: number;
  memRequired: number;
  status: TaskStatus;
  assignedWorkerId: string | null;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  createdAt: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  deadlineAt: number | null;
  exitCode: number | null;
  lastError: string | null;
}

export const TERMINAL_STATUSES: TaskStatus[] = ["SUCCESS", "FAILED", "CANCELLED"];

export const isTerminal = (task: Task) => TERMINAL_STATUSES.includes(task.status);

interface ClusterStore {
  workers: Map<string, Worker>;
  tasks: Map<string, Task>;
  logs: Map<string, string[]>;
  connectionStatus: ConnectionStatus;
  activeTaskId: string;
  /** serverTime - Date.now() at the last frame, so ages stay correct under clock skew. */
  clockOffset: number;
  lastError: string;
}

/**
 * The single source of truth for the dashboard.
 *
 * The master sends one snapshot on connect and incremental upserts afterwards,
 * so entities are held in Maps and patched by id rather than replaced wholesale.
 */
export const store = reactive<ClusterStore>({
  workers: new Map(),
  tasks: new Map(),
  logs: new Map(),
  connectionStatus: "connecting",
  activeTaskId: "",
  clockOffset: 0,
  lastError: "",
});

export function replaceSnapshot(workers: Worker[], tasks: Task[]) {
  store.workers = new Map(workers.map((worker) => [worker.id, worker]));
  store.tasks = new Map(tasks.map((task) => [task.id, task]));
}

export function upsertWorker(worker: Worker) {
  store.workers.set(worker.id, worker);
}

export function removeWorker(workerId: string) {
  store.workers.delete(workerId);
}

export function upsertTask(task: Task) {
  store.tasks.set(task.id, task);
}

export function removeTask(taskId: string) {
  store.tasks.delete(taskId);
  store.logs.delete(taskId);
  if (store.activeTaskId === taskId) store.activeTaskId = "";
}

const LOG_LIMIT = 5000;

export function appendLogs(taskId: string, lines: string[]) {
  const buffer = store.logs.get(taskId) ?? [];
  buffer.push(...lines);
  if (buffer.length > LOG_LIMIT) buffer.splice(0, buffer.length - LOG_LIMIT);
  store.logs.set(taskId, buffer);
}

export function setLogs(taskId: string, lines: string[]) {
  store.logs.set(taskId, lines.slice(-LOG_LIMIT));
}

/** The master's clock, as best this client can estimate it. */
export function serverNow() {
  return Date.now() + store.clockOffset;
}

/* --------------------------------------------------------------------------
 * Derived views
 * -------------------------------------------------------------------------- */

export const workerList = computed(() =>
  [...store.workers.values()].sort((a, b) => a.id.localeCompare(b.id)),
);

export const taskList = computed(() =>
  [...store.tasks.values()].sort((a, b) => b.createdAt - a.createdAt),
);

export const onlineWorkers = computed(
  () => workerList.value.filter((worker) => worker.status === "ONLINE").length,
);

export const clusterCapacity = computed(() => {
  const online = workerList.value.filter((worker) => worker.status === "ONLINE");
  return online.reduce(
    (totals, worker) => ({
      cpuTotal: totals.cpuTotal + worker.cpuTotal,
      cpuUsed: totals.cpuUsed + worker.cpuUsed,
      memTotal: totals.memTotal + worker.memTotal,
      memUsed: totals.memUsed + worker.memUsed,
    }),
    { cpuTotal: 0, cpuUsed: 0, memTotal: 0, memUsed: 0 },
  );
});

export const tasksByStatus = computed(() => {
  const counts: Record<TaskStatus, number> = {
    PENDING: 0,
    RUNNING: 0,
    SUCCESS: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  for (const task of store.tasks.values()) counts[task.status] += 1;
  return counts;
});

export const successRate = computed(() => {
  const { SUCCESS, FAILED } = tasksByStatus.value;
  const completed = SUCCESS + FAILED;
  return completed ? Math.round((SUCCESS / completed) * 100) : null;
});

export const averageDurationMs = computed(() => {
  const durations = [...store.tasks.values()]
    .filter((task) => task.startedAt && task.finishedAt)
    .map((task) => task.finishedAt! - task.startedAt!);
  if (!durations.length) return null;
  return durations.reduce((sum, value) => sum + value, 0) / durations.length;
});
