/** Fleet and workload used to seed the in-browser demo cluster. */

export interface DemoWorkerSpec {
  id: string;
  host: string;
  port: number;
  cpuTotal: number;
  memTotal: number;
}

export const DEMO_WORKERS: DemoWorkerSpec[] = [
  { id: "worker-alpha", host: "10.0.1.11", port: 4001, cpuTotal: 8, memTotal: 16 },
  { id: "worker-beta", host: "10.0.1.12", port: 4001, cpuTotal: 4, memTotal: 8 },
  { id: "worker-gamma", host: "10.0.1.13", port: 4001, cpuTotal: 2, memTotal: 4 },
];

export interface DemoJob {
  command: string;
  cpu: number;
  mem: number;
  /** Simulated wall-clock runtime. */
  durationMs: number;
  /** Lines the fake process writes, spread across its runtime. */
  output: string[];
  /** Probability the process exits non-zero. */
  failureRate?: number;
}

const INGEST: DemoJob = {
  command: "node etl/ingest.js --source events --batch 5000",
  cpu: 2,
  mem: 4,
  durationMs: 9000,
  output: [
    "connecting to events stream",
    "batch 1/5 ingested (5000 rows)",
    "batch 2/5 ingested (5000 rows)",
    "batch 3/5 ingested (5000 rows)",
    "batch 4/5 ingested (5000 rows)",
    "batch 5/5 ingested (5000 rows)",
    "wrote 25000 rows in 8.4s",
  ],
};

const TRAIN: DemoJob = {
  command: "python train.py --model ranker --epochs 3",
  cpu: 4,
  mem: 8,
  durationMs: 14000,
  failureRate: 0.15,
  output: [
    "loading dataset (182k samples)",
    "epoch 1/3  loss=0.482  acc=0.811",
    "epoch 2/3  loss=0.311  acc=0.874",
    "epoch 3/3  loss=0.244  acc=0.902",
    "saved checkpoint to s3://models/ranker-latest",
  ],
};

const REPORT: DemoJob = {
  command: "sh scripts/nightly-report.sh --format pdf",
  cpu: 1,
  mem: 1,
  durationMs: 5000,
  output: [
    "collecting metrics for the last 24h",
    "rendering 14 charts",
    "report written to reports/nightly.pdf",
  ],
};

const THUMBNAILS: DemoJob = {
  command: "node tools/thumbnails.js --queue uploads --workers 4",
  cpu: 2,
  mem: 2,
  durationMs: 7000,
  output: [
    "claimed 240 uploads",
    "resized 80/240",
    "resized 160/240",
    "resized 240/240",
    "queue drained",
  ],
};

const MIGRATION: DemoJob = {
  command: "psql -f migrations/add-events-index.sql",
  cpu: 1,
  mem: 2,
  durationMs: 4000,
  failureRate: 0.2,
  output: [
    "BEGIN",
    "CREATE INDEX CONCURRENTLY idx_events_created_at",
    "ANALYZE events",
    "COMMIT",
  ],
};

const REPLAY: DemoJob = {
  command: "node bench/replay.js --trace prod-latest --speed 4x",
  cpu: 6,
  mem: 12,
  durationMs: 16000,
  output: [
    "replaying 1.2M requests at 4x",
    "p50=12ms  p95=48ms  p99=131ms",
    "no regressions against baseline",
  ],
};

export const DEMO_JOBS: DemoJob[] = [
  INGEST,
  TRAIN,
  REPORT,
  THUMBNAILS,
  MIGRATION,
  REPLAY,
];

/** A job that only the largest node can hold, used to show the aging barrier. */
export const DEMO_LARGE_JOB: DemoJob = {
  command: "node bench/full-cluster-sweep.js --whole-node",
  cpu: 8,
  mem: 16,
  durationMs: 12000,
  output: [
    "reserved the entire node",
    "sweeping parameter grid (64 points)",
    "best configuration: batch=512 workers=8",
  ],
};

export function pickJob(random: () => number = Math.random): DemoJob {
  const index = Math.floor(random() * DEMO_JOBS.length) % DEMO_JOBS.length;
  return DEMO_JOBS[index] ?? INGEST;
}

export interface DemoHistoryEntry {
  job: DemoJob;
  workerId: string;
  status: "SUCCESS" | "FAILED";
  startedAgoMs: number;
  durationMs: number;
  exitCode: number;
}

/** Finished tasks so the dashboard has history the moment it loads. */
export const DEMO_HISTORY: DemoHistoryEntry[] = [
  {
    job: INGEST,
    workerId: "worker-alpha",
    status: "SUCCESS",
    startedAgoMs: 11 * 60_000,
    durationMs: 9_400,
    exitCode: 0,
  },
  {
    job: REPORT,
    workerId: "worker-gamma",
    status: "SUCCESS",
    startedAgoMs: 8 * 60_000,
    durationMs: 5_100,
    exitCode: 0,
  },
  {
    job: MIGRATION,
    workerId: "worker-beta",
    status: "FAILED",
    startedAgoMs: 6 * 60_000,
    durationMs: 3_800,
    exitCode: 1,
  },
  {
    job: THUMBNAILS,
    workerId: "worker-alpha",
    status: "SUCCESS",
    startedAgoMs: 4 * 60_000,
    durationMs: 7_200,
    exitCode: 0,
  },
  {
    job: TRAIN,
    workerId: "worker-alpha",
    status: "SUCCESS",
    startedAgoMs: 2 * 60_000,
    durationMs: 13_900,
    exitCode: 0,
  },
];
