import { state } from "../store/state";

const apiOrigin = import.meta.env.VITE_API_URL || "http://127.0.0.1:3000";
const wsUrl = apiOrigin.replace(/^http/, "ws");
let ws: WebSocket | null = null;
let reconnectTimer: number | undefined;

export function connectWS() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  state.connectionStatus = "connecting";
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    state.connectionStatus = "connected";
    if (state.activeTaskId) subscribeLog(state.activeTaskId);
  };
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "cluster:update") state.workers = message.workers;
      if (message.type === "tasks:update") state.tasks = message.tasks;
      if (message.type === "task:log") state.appendLog(message.taskId, message.line);
    } catch (error) {
      console.warn("Ignored malformed scheduler event", error);
    }
  };
  ws.onclose = () => {
    state.connectionStatus = "disconnected";
    ws = null;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectWS, 2500);
  };
  ws.onerror = () => ws?.close();
}

export async function subscribeLog(taskId: string) {
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "subscribeLog", taskId }));
  try {
    const response = await fetch(`${apiOrigin}/tasks/${encodeURIComponent(taskId)}/logs`);
    if (response.ok) state.logs.set(taskId, (await response.json()).lines);
  } catch {
    // Live events continue even when the initial history request is unavailable.
  }
}

export function unsubscribeLog() {
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "unsubscribeLog" }));
}

export async function createTask(payload: { command: string; cpu_required: number; mem_required: number }) {
  const response = await fetch(`${apiOrigin}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "Task creation failed");
  return response.json();
}
