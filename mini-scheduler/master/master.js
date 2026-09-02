#!/usr/bin/env node
import { createMaster } from "./src/server.js";

const master = createMaster();
const address = await master.start();
const port = typeof address === "object" && address ? address.port : master.config.port;

console.log(`[master] http  listening on http://127.0.0.1:${port}`);
console.log(`[master] ws    listening on ws://127.0.0.1:${port}`);
console.log(
  master.config.token
    ? "[master] auth  shared token required"
    : "[master] auth  DISABLED (development mode) — set SCHEDULER_TOKEN to require one",
);
console.log(`[master] cors  ${master.config.corsOrigins.join(", ")}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[master] ${signal} received, shutting down`);
    master.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
