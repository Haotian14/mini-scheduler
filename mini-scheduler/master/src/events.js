/**
 * WebSocket fan-out.
 *
 * The first version of this scheduler re-broadcast the *entire* worker and task
 * list on every heartbeat, which is O(tasks x workers) traffic every couple of
 * seconds. Here clients receive one snapshot on connect and incremental
 * upserts afterwards, coalesced over a short window so that a burst of changes
 * costs a single frame.
 *
 * Log lines are only delivered to the clients that subscribed to that task.
 */

export class EventHub {
  constructor({ state, intervalMs = 100, clock = Date.now } = {}) {
    this.state = state;
    this.intervalMs = intervalMs;
    this.clock = clock;

    /** @type {Set<import("ws").WebSocket>} */
    this.clients = new Set();
    this.dirtyWorkers = new Set();
    this.dirtyTasks = new Set();
    this.removedWorkers = new Set();
    this.removedTasks = new Set();
    /** @type {Map<string, string[]>} */
    this.pendingLogs = new Map();
    this.flushTimer = null;
  }

  /** Change listeners handed to {@link ClusterState}. */
  listeners() {
    return {
      workerChanged: (id) => this.mark(this.dirtyWorkers, id),
      workerRemoved: (id) => {
        this.dirtyWorkers.delete(id);
        this.mark(this.removedWorkers, id);
      },
      taskChanged: (id) => this.mark(this.dirtyTasks, id),
      taskRemoved: (id) => {
        this.dirtyTasks.delete(id);
        this.pendingLogs.delete(id);
        this.mark(this.removedTasks, id);
      },
      taskLog: (taskId, lines) => {
        const buffered = this.pendingLogs.get(taskId) ?? [];
        buffered.push(...lines);
        this.pendingLogs.set(taskId, buffered);
        this.scheduleFlush();
      },
    };
  }

  mark(set, id) {
    set.add(id);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.intervalMs);
    this.flushTimer.unref?.();
  }

  addClient(ws) {
    this.clients.add(ws);
    ws.subscribedTaskId = null;
    this.send(ws, {
      type: "snapshot",
      serverTime: this.clock(),
      workers: this.state.snapshotWorkers(),
      tasks: this.state.snapshotTasks(),
    });
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  handleClientMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "subscribeLog" && typeof message.taskId === "string") {
      ws.subscribedTaskId = message.taskId;
    } else if (message.type === "unsubscribeLog") {
      ws.subscribedTaskId = null;
    }
  }

  send(ws, payload) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(payload));
  }

  /** Emit everything accumulated since the last flush. */
  flush() {
    const events = [];

    for (const id of this.dirtyWorkers) {
      const worker = this.state.workers.get(id);
      if (worker)
        events.push({ type: "worker:upsert", worker: this.state.workerView(worker) });
    }
    for (const id of this.removedWorkers) {
      events.push({ type: "worker:remove", workerId: id });
    }
    for (const id of this.dirtyTasks) {
      const task = this.state.tasks.get(id);
      if (task) events.push({ type: "task:upsert", task: this.state.taskView(task) });
    }
    for (const id of this.removedTasks) {
      events.push({ type: "task:remove", taskId: id });
    }

    this.dirtyWorkers.clear();
    this.dirtyTasks.clear();
    this.removedWorkers.clear();
    this.removedTasks.clear();

    if (events.length) {
      const frame = JSON.stringify({
        type: "batch",
        serverTime: this.clock(),
        events,
      });
      for (const ws of this.clients) {
        if (ws.readyState === 1) ws.send(frame);
      }
    }

    if (this.pendingLogs.size) {
      for (const [taskId, lines] of this.pendingLogs) {
        for (const ws of this.clients) {
          if (ws.subscribedTaskId !== taskId) continue;
          this.send(ws, { type: "task:log", taskId, lines });
        }
      }
      this.pendingLogs.clear();
    }

    return events.length;
  }

  close() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const ws of this.clients) ws.close();
    this.clients.clear();
  }
}
