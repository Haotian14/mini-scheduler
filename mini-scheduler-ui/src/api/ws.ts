import { state } from "../store/state";

let ws: WebSocket | null = null;

export function connectWS() {
  ws = new WebSocket("ws://127.0.0.1:3000");

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "cluster:update") {
      state.workers = msg.workers;
    }

    if (msg.type === "tasks:update") {
      state.tasks = msg.tasks;
    }

    if (msg.type === "task:log") {
      state.appendLog(msg.taskId, msg.line);
    }
  };
}

export function subscribeLog(taskId: string) {
  ws?.send(JSON.stringify({ type: "subscribeLog", taskId }));
}

export function unsubscribeLog() {
  ws?.send(JSON.stringify({ type: "unsubscribeLog" }));
}
