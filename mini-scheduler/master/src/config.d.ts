export interface SchedulerConfig {
  production: boolean;
  port: number;
  token: string;
  corsOrigins: string[];
  heartbeatTimeoutMs: number;
  sweepIntervalMs: number;
  broadcastIntervalMs: number;
  taskTimeoutMs: number;
  maxAttempts: number;
  retryCooldownMs: number;
  agingMs: number;
  taskRetention: number;
  logRetention: number;
}

/**
 * Pure with respect to `env`, so tests (and the browser demo) can build a
 * configuration without touching `process.env`.
 */
export function loadConfig(env?: Record<string, string | undefined>): SchedulerConfig;
