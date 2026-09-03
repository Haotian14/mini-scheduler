export type TaskStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
export type WorkerStatus = "ONLINE" | "OFFLINE";

export const TERMINAL_STATUSES: Set<TaskStatus>;

/** A worker as the master tracks it, with both views of its usage. */
export interface WorkerRecord {
  id: string;
  host: string;
  port: number;
  cpuTotal: number;
  memTotal: number;
  /** Committed by the scheduler when it assigns a task. */
  cpuReserved: number;
  memReserved: number;
  /** Last value the worker itself reported in a heartbeat. */
  cpuReported: number;
  memReported: number;
  assignedTaskIds: Set<string>;
  reportedTaskIds: Set<string>;
  status: WorkerStatus;
  registeredAt: number;
  lastHeartbeatAt: number;
}

/** What clients see: `cpuUsed` is the safe merge of reserved and reported. */
export interface WorkerView {
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

export interface TaskRecord {
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
  /** workerId -> timestamp until which that worker is skipped for this task. */
  cooldowns: Map<string, number>;
}

export type TaskView = Omit<TaskRecord, "cooldowns">;

export interface StateEvents {
  workerChanged?(workerId: string): void;
  workerRemoved?(workerId: string): void;
  taskChanged?(taskId: string): void;
  taskRemoved?(taskId: string): void;
  taskLog?(taskId: string, lines: string[]): void;
}

export interface ClusterStateOptions {
  taskRetention?: number;
  logRetention?: number;
  clock?: () => number;
  events?: StateEvents;
}

export interface ClusterStats {
  workers: number;
  onlineWorkers: number;
  tasks: number;
  tasksByStatus: Record<string, number>;
  bufferedLogTasks: number;
}

export class ClusterState {
  constructor(options?: ClusterStateOptions);

  taskRetention: number;
  logRetention: number;
  workers: Map<string, WorkerRecord>;
  tasks: Map<string, TaskRecord>;
  logs: Map<string, string[]>;

  now(): number;
  nextId(prefix: string): string;

  registerWorker(input: {
    workerId: string;
    host?: string;
    port: number;
    cpuTotal: number;
    memTotal: number;
  }): { worker: WorkerRecord; releasedTaskIds: string[] };

  applyHeartbeat(input: {
    workerId: string;
    cpuUsed?: number;
    memUsed?: number;
    runningTaskIds?: string[];
  }): boolean;

  markOffline(workerId: string): string[];
  releaseWorkerTasks(workerId: string, options?: { reason?: string }): string[];
  removeWorker(workerId: string): string[];

  static usage(worker: WorkerRecord): { cpu: number; mem: number };
  workerView(worker: WorkerRecord): WorkerView;
  snapshotWorkers(): WorkerView[];

  createTask(input: {
    command: string;
    cpuRequired: number;
    memRequired: number;
    maxAttempts: number;
    timeoutMs: number;
  }): TaskRecord;

  assignTask(taskId: string, workerId: string): TaskRecord | null;
  releaseReservation(task: TaskRecord): void;
  requeueTask(
    task: TaskRecord,
    options?: {
      failedWorkerId?: string | null;
      error?: string | null;
      cooldownMs?: number;
    },
  ): TaskRecord;
  finishTask(
    taskId: string,
    result: { exitCode?: number | null; status?: TaskStatus },
  ): TaskRecord | null;
  cancelTask(taskId: string): { task: TaskRecord; workerId: string | null } | null;

  taskView(task: TaskRecord): TaskView;
  snapshotTasks(): TaskView[];
  pendingTasks(): TaskRecord[];
  pruneTasks(): void;

  appendLog(taskId: string, ...lines: Array<string | string[]>): string[];
  getLogs(taskId: string): string[];
  stats(): ClusterStats;
}
