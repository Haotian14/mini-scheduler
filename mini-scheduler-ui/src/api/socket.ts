import {
  appendLogs,
  removeTask,
  removeWorker,
  replaceSnapshot,
  setLogs,
  store,
  upsertTask,
  upsertWorker,
  type Task,
  type Worker,
} from "../store/cluster";
import { apiOrigin, apiToken, fetchTaskLogs } from "./client";

type ServerEvent =
  | { type: "worker:upsert"; worker: Worker }
  | { type: "worker:remove"; workerId: string }
  | { type: "task:upsert"; task: Task }
  | { type: "task:remove"; taskId: string };

type ServerFrame =
  | { type: "snapshot"; serverTime: number; workers: Worker[]; tasks: Task[] }
  | { type: "batch"; serverTime: number; events: ServerEvent[] }
  | { type: "task:log"; taskId: string; lines: string[] };

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;

function socketUrl() {
  const url = new URL(apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (apiToken) url.searchParams.set("token", apiToken);
  return url.toString();
}

function applyEvent(event: ServerEvent) {
  switch (event.type) {
    case "worker:upsert":
      return upsertWorker(event.worker);
    case "worker:remove":
      return removeWorker(event.workerId);
    case "task:upsert":
      return upsertTask(event.task);
    case "task:remove":
      return removeTask(event.taskId);
  }
}

function handleFrame(frame: ServerFrame) {
  if (frame.type === "snapshot") {
    store.clockOffset = frame.serverTime - Date.now();
    replaceSnapshot(frame.workers, frame.tasks);
    return;
  }
  if (frame.type === "batch") {
    store.clockOffset = frame.serverTime - Date.now();
    frame.events.forEach(applyEvent);
    return;
  }
  if (frame.type === "task:log") {
    appendLogs(frame.taskId, frame.lines);
  }
}

/**
 * Connect, and keep reconnecting with exponential backoff. On every successful
 * open the current log subscription is restored, so a dropped connection is
 * invisible to someone watching a task's output.
 */
export function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  store.connectionStatus = "connecting";
  socket = new WebSocket(socketUrl());

  socket.onopen = () => {
    reconnectAttempts = 0;
    store.connectionStatus = "connected";
    store.lastError = "";
    if (store.activeTaskId) subscribeLog(store.activeTaskId);
  };

  socket.onmessage = (event) => {
    try {
      handleFrame(JSON.parse(event.data) as ServerFrame);
    } catch (error) {
      console.warn("Ignored malformed scheduler frame", error);
    }
  };

  socket.onclose = () => {
    socket = null;
    store.connectionStatus = "disconnected";
    scheduleReconnect();
  };

  socket.onerror = () => socket?.close();
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(connect, delay);
}

function send(payload: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

/** Start following a task: fetch the history once, then stream the tail. */
export async function subscribeLog(taskId: string) {
  send({ type: "subscribeLog", taskId });
  try {
    const { lines } = await fetchTaskLogs(taskId);
    setLogs(taskId, lines);
  } catch {
    // History is a nice-to-have; live lines keep arriving over the socket.
  }
}

export function unsubscribeLog() {
  send({ type: "unsubscribeLog" });
}

export function disconnect() {
  window.clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
}
