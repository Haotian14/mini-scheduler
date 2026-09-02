#!/usr/bin/env node
import { createWorker } from "./src/server.js";

const worker = createWorker();
const address = await worker.start();
const port = typeof address === "object" && address ? address.port : worker.config.port;

console.log(
  `[worker] ${worker.config.workerId} listening on http://${worker.config.host}:${port}`,
);
console.log(
  `[worker] capacity ${worker.config.cpuTotal} CPU / ${worker.config.memTotal} GB`,
);
console.log(
  worker.config.token
    ? "[worker] auth  shared token required"
    : "[worker] auth  DISABLED (development mode) — set SCHEDULER_TOKEN to require one",
);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, draining`);
    worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
