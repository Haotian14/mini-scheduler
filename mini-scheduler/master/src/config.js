/**
 * Central configuration for the master.
 *
 * Every tunable lives here so that timings used by the scheduler, the offline
 * detector and the tests never drift apart. `loadConfig` is pure with respect
 * to its `env` argument, which lets tests build a configuration without
 * touching `process.env`.
 */

const DEFAULT_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const token = env.SCHEDULER_TOKEN || "";

  if (production && !token) {
    throw new Error(
      "SCHEDULER_TOKEN is required when NODE_ENV=production: the task API " +
        "executes shell commands and must never be exposed unauthenticated.",
    );
  }

  return {
    production,
    port: num(env.PORT, 3000),
    token,

    /** Origins allowed to call the API from a browser. "*" disables the check. */
    corsOrigins: list(env.CORS_ORIGIN, DEFAULT_DEV_ORIGINS),

    /** A worker is declared OFFLINE after this long without a heartbeat. */
    heartbeatTimeoutMs: num(env.HEARTBEAT_TIMEOUT_MS, 6000),
    /** How often the offline detector and the deadline sweeper run. */
    sweepIntervalMs: num(env.SWEEP_INTERVAL_MS, 1000),
    /** WebSocket events are coalesced over this window before being flushed. */
    broadcastIntervalMs: num(env.BROADCAST_INTERVAL_MS, 100),

    /** Wall-clock budget for a single task attempt. */
    taskTimeoutMs: num(env.TASK_TIMEOUT_MS, 30 * 60 * 1000),
    /** Total attempts per task, including the first one. */
    maxAttempts: num(env.MAX_ATTEMPTS, 3),
    /** A worker that failed a task is skipped for this long when re-queuing. */
    retryCooldownMs: num(env.RETRY_COOLDOWN_MS, 10_000),
    /**
     * Once the oldest pending task has waited this long it becomes a barrier:
     * smaller tasks stop overtaking it. Prevents indefinite starvation of
     * large tasks while still allowing backfill before the threshold.
     */
    agingMs: num(env.AGING_MS, 15_000),

    /** Terminal tasks kept in memory (running/pending tasks are never evicted). */
    taskRetention: num(env.TASK_RETENTION, 500),
    /** Log lines kept per task. */
    logRetention: num(env.LOG_RETENTION, 5000),
  };
}
