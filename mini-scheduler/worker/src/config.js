/** Worker configuration. Pure with respect to `env` so tests can inject one. */
function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const token = env.SCHEDULER_TOKEN || "";

  if (production && !token) {
    throw new Error(
      "SCHEDULER_TOKEN is required when NODE_ENV=production: /run executes " +
        "shell commands and must never be exposed unauthenticated.",
    );
  }

  return {
    production,
    token,
    workerId: env.WORKER_ID || `worker_${Math.random().toString(16).slice(2, 8)}`,
    host: env.WORKER_HOST || "127.0.0.1",
    port: num(env.WORKER_PORT, 4001),
    masterUrl: env.MASTER_URL || "http://127.0.0.1:3000",

    cpuTotal: num(env.CPU_TOTAL, 4),
    memTotal: num(env.MEM_TOTAL, 8),

    heartbeatIntervalMs: num(env.HEARTBEAT_INTERVAL_MS, 2000),
    /** Log lines are flushed when either bound is reached. */
    logFlushIntervalMs: num(env.LOG_FLUSH_INTERVAL_MS, 100),
    logFlushBytes: num(env.LOG_FLUSH_BYTES, 4096),
    /** Beyond this many buffered lines the worker drops output instead of growing. */
    logBufferLimit: num(env.LOG_BUFFER_LIMIT, 2000),

    /** Retry budget for reports the master must eventually receive. */
    reportRetries: num(env.REPORT_RETRIES, 6),
    reportBackoffMs: num(env.REPORT_BACKOFF_MS, 250),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 5000),
    /** Grace period between SIGTERM and SIGKILL when cancelling a task. */
    killGraceMs: num(env.KILL_GRACE_MS, 3000),
  };
}
