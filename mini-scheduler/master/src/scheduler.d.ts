import type { ClusterState, TaskRecord, WorkerRecord, WorkerView } from "./state.js";
import type { SchedulerConfig } from "./config.js";

/** The shape `planAssignments` needs from a worker. */
export interface PlannerWorker {
  id: string;
  cpuTotal: number;
  memTotal: number;
  cpuUsed: number;
  memUsed: number;
  status: string;
}

/** The shape `planAssignments` needs from a task. */
export interface PlannerTask {
  id: string;
  cpuRequired: number;
  memRequired: number;
  queuedAt: number;
  cooldowns?: Map<string, number>;
}

export interface Assignment {
  taskId: string;
  workerId: string;
}

export interface Plan {
  assignments: Assignment[];
  /** The aged task that stopped the queue, if any. */
  blockedBy: string | null;
  /** Tasks no online worker could ever hold. */
  infeasible: string[];
}

export function fitScore(worker: PlannerWorker, task: PlannerTask): number;
export function fits(worker: PlannerWorker, task: PlannerTask): boolean;
export function isFeasible(workers: PlannerWorker[], task: PlannerTask): boolean;

/**
 * Pure placement policy: FIFO with backfill, plus an aging barrier that stops
 * small tasks from overtaking a large one indefinitely.
 */
export function planAssignments(input: {
  workers: Array<PlannerWorker | WorkerView>;
  tasks: PlannerTask[];
  now: number;
  agingMs: number;
}): Plan;

export interface SchedulerDeps {
  state: ClusterState;
  config: SchedulerConfig;
  dispatch(worker: WorkerRecord, task: TaskRecord): Promise<unknown>;
  cancel?(worker: WorkerRecord, taskId: string): Promise<unknown>;
  log?(...args: unknown[]): void;
}

export class Scheduler {
  constructor(deps: SchedulerDeps);
  /** Plan, commit and dispatch; resolves with the number dispatched. */
  schedule(): Promise<number>;
  commit(taskId: string, workerId: string): Promise<boolean>;
  /** Offline detection and deadline enforcement. */
  sweep(): Promise<boolean>;
  start(): void;
  stop(): void;
}
