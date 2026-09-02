import type { Task, Worker } from "../store/cluster";

/**
 * REST client for the master.
 *
 * `VITE_SCHEDULER_TOKEN` is a development convenience: a shared secret shipped
 * in the bundle is not user authentication, it only keeps the API from being
 * open to any page that happens to be running in the same browser. Real
 * deployments should put the dashboard behind a proper login.
 */
export const apiOrigin = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";
export const apiToken = import.meta.env.VITE_SCHEDULER_TOKEN ?? "";

export interface CreateTaskInput {
  command: string;
  cpu_required: number;
  mem_required: number;
}

function headers() {
  return {
    "content-type": "application/json",
    ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers: headers() });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const createTask = (input: CreateTaskInput) =>
  request<{ taskId: string; status: string }>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const cancelTask = (taskId: string) =>
  request<{ ok: boolean; task: Task }>(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
  });

export const fetchTaskLogs = (taskId: string) =>
  request<{ lines: string[] }>(`/tasks/${encodeURIComponent(taskId)}/logs`);

export const fetchTasks = () => request<{ tasks: Task[] }>("/tasks");

export const fetchWorkers = () => request<{ workers: Worker[] }>("/workers");
