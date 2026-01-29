import { reactive } from "vue";

export interface Worker {
  id: string;
  cpuTotal: number;
  memTotal: number;
  cpuUsed: number;
  memUsed: number;
  status: "ONLINE" | "OFFLINE";
}

export interface Task {
  id: string;
  status: string;
  assignedWorkerId?: string;
}

export const state = reactive({
  workers: [] as Worker[],
  tasks: [] as Task[],
  activeTaskId: "" as string,
  logs: new Map<string, string[]>(),

  appendLog(taskId: string, line: string) {
    if (!this.logs.has(taskId)) {
      this.logs.set(taskId, []);
    }
    const arr = this.logs.get(taskId)!;
    arr.push(line);
    if (arr.length > 5000) arr.shift();
  },
});
