import { reactive } from "vue";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type TaskStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface Worker {
  id: string;
  host: string;
  cpuTotal: number;
  memTotal: number;
  cpuUsed: number;
  memUsed: number;
  status: "ONLINE" | "OFFLINE";
  lastHeartbeatAt: number;
  runningTasks: string[];
}

export interface Task {
  id: string;
  command: string;
  cpuRequired: number;
  memRequired: number;
  status: TaskStatus;
  assignedWorkerId?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  exitCode?: number | null;
}

export const state = reactive({
  workers: [] as Worker[],
  tasks: [] as Task[],
  connectionStatus: "connecting" as ConnectionStatus,
  activeTaskId: "",
  logs: new Map<string, string[]>(),

  appendLog(taskId: string, line: string) {
    const lines = this.logs.get(taskId) ?? [];
    lines.push(line);
    if (lines.length > 5000) lines.splice(0, lines.length - 5000);
    this.logs.set(taskId, lines);
  },
});
