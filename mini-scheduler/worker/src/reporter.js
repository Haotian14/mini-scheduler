/**
 * Everything the worker sends back to the master.
 *
 * Two problems the first version had are fixed here:
 *
 *  1. One HTTP request per stdout chunk. A chatty task could saturate the
 *     master. Output is now batched per task and flushed on a size or time
 *     bound, with a hard cap on the buffer so a runaway process degrades into
 *     dropped log lines instead of unbounded memory.
 *  2. Silent failures. `finish` used to be fire-and-forget, so a transient
 *     network error left the task RUNNING on the master forever. Reports are
 *     now retried with exponential backoff, and the master's deadline sweeper
 *     is the backstop if they never land.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MasterClient {
  constructor(config, { fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    /** @type {Map<string, {lines: string[], bytes: number, dropped: number, timer: any}>} */
    this.buffers = new Map();
    this.flushing = new Map();
  }

  headers() {
    return {
      "content-type": "application/json",
      ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
    };
  }

  /** Single attempt; throws on any non-2xx. */
  async postOnce(path, body) {
    const response = await this.fetchImpl(`${this.config.masterUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`master responded ${response.status} ${detail}`.trim());
    }
    return response.json().catch(() => ({}));
  }

  /**
   * Retry with exponential backoff. 4xx responses other than 429 are not
   * retried: a rejected payload will be rejected again.
   */
  async post(path, body, { retries = this.config.reportRetries } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.postOnce(path, body);
      } catch (error) {
        lastError = error;
        const status = Number(/responded (\d{3})/.exec(String(error.message))?.[1]);
        if (status >= 400 && status < 500 && status !== 429) throw error;
        if (attempt === retries) break;
        await sleep(this.config.reportBackoffMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  register() {
    return this.post("/workers/register", {
      workerId: this.config.workerId,
      host: this.config.host,
      port: this.config.port,
      cpuTotal: this.config.cpuTotal,
      memTotal: this.config.memTotal,
    });
  }

  heartbeat(payload) {
    // Heartbeats are cheap and frequent: a missed one is covered by the next.
    return this.post(
      "/workers/heartbeat",
      { workerId: this.config.workerId, ...payload },
      { retries: 0 },
    );
  }

  deregister() {
    return this.post(
      "/workers/deregister",
      { workerId: this.config.workerId },
      { retries: 1 },
    );
  }

  /** Queue output for a task; flushed by size or by timer, whichever first. */
  appendLog(taskId, stream, chunk) {
    const key = `${taskId} ${stream}`;
    const buffer = this.buffers.get(key) ?? {
      lines: [],
      bytes: 0,
      dropped: 0,
      timer: null,
    };

    for (const line of chunk.replace(/\r\n/g, "\n").split("\n")) {
      if (!line.length) continue;
      if (buffer.lines.length >= this.config.logBufferLimit) {
        buffer.dropped += 1;
        continue;
      }
      buffer.lines.push(line);
      buffer.bytes += line.length;
    }

    this.buffers.set(key, buffer);

    if (buffer.bytes >= this.config.logFlushBytes) {
      this.flushLogs(taskId, stream).catch(() => {});
    } else if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        this.flushLogs(taskId, stream).catch(() => {});
      }, this.config.logFlushIntervalMs);
      buffer.timer.unref?.();
    }
  }

  /**
   * Flush one buffer. Concurrent flushes for the same stream are chained so
   * log lines reach the master in the order the process produced them.
   */
  async flushLogs(taskId, stream) {
    const key = `${taskId} ${stream}`;
    const buffer = this.buffers.get(key);
    if (!buffer || (!buffer.lines.length && !buffer.dropped)) return;

    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    const lines = buffer.lines;
    if (buffer.dropped) {
      lines.push(`[dropped ${buffer.dropped} line(s): output rate too high]`);
      buffer.dropped = 0;
    }
    buffer.lines = [];
    buffer.bytes = 0;

    const previous = this.flushing.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() =>
        this.post(
          `/workers/task/${encodeURIComponent(taskId)}/log`,
          { stream, lines },
          { retries: 1 },
        ).catch(() => {}),
      );
    this.flushing.set(key, next);
    return next;
  }

  /** Flush both streams of a task and forget its buffers. */
  async flushTask(taskId) {
    await Promise.all([
      this.flushLogs(taskId, "stdout"),
      this.flushLogs(taskId, "stderr"),
    ]);
    this.buffers.delete(`${taskId} stdout`);
    this.buffers.delete(`${taskId} stderr`);
    this.flushing.delete(`${taskId} stdout`);
    this.flushing.delete(`${taskId} stderr`);
  }

  /** Report a terminal result. Logs are flushed first so ordering holds. */
  async finish(taskId, exitCode) {
    await this.flushTask(taskId);
    return this.post(`/workers/task/${encodeURIComponent(taskId)}/finish`, {
      workerId: this.config.workerId,
      exitCode,
    });
  }
}
