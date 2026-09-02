import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";
import { MasterClient } from "../src/reporter.js";

/** A fetch stand-in that records calls and replays scripted responses. */
function fakeFetch(script = []) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    const next = script.shift() ?? { ok: true };
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.ok !== false,
      status: next.status ?? (next.ok === false ? 500 : 200),
      json: async () => next.json ?? {},
      text: async () => next.text ?? "",
    };
  };
  impl.calls = calls;
  return impl;
}

const config = (overrides = {}) =>
  loadConfig({
    SCHEDULER_TOKEN: "tok",
    LOG_FLUSH_INTERVAL_MS: "10",
    LOG_FLUSH_BYTES: "50",
    LOG_BUFFER_LIMIT: "5",
    REPORT_BACKOFF_MS: "1",
    REPORT_RETRIES: "3",
    ...overrides,
  });

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("output is batched into one request instead of one per chunk", async () => {
  const fetchImpl = fakeFetch();
  const client = new MasterClient(config(), { fetchImpl });

  client.appendLog("t1", "stdout", "one\n");
  client.appendLog("t1", "stdout", "two\n");
  client.appendLog("t1", "stdout", "three\n");
  await tick();

  assert.equal(fetchImpl.calls.length, 1, "three chunks, one HTTP request");
  assert.deepEqual(fetchImpl.calls[0].body.lines, ["one", "two", "three"]);
  assert.match(fetchImpl.calls[0].url, /\/workers\/task\/t1\/log$/);
});

test("a large burst is flushed on the size bound without waiting for the timer", async () => {
  const fetchImpl = fakeFetch();
  const client = new MasterClient(config(), { fetchImpl });

  client.appendLog("t1", "stdout", `${"x".repeat(60)}\n`);
  await tick(1);

  assert.equal(fetchImpl.calls.length, 1);
});

test("a runaway process drops lines instead of growing without bound", async () => {
  const fetchImpl = fakeFetch();
  const client = new MasterClient(config({ LOG_FLUSH_BYTES: "1000000" }), { fetchImpl });

  for (let index = 0; index < 50; index += 1) {
    client.appendLog("t1", "stdout", `line ${index}\n`);
  }
  await tick();

  const { lines } = fetchImpl.calls[0].body;
  assert.equal(lines.length, 6, "five buffered lines plus one notice");
  assert.match(lines.at(-1), /dropped 45 line\(s\)/);
});

test("stdout and stderr are reported as separate streams", async () => {
  const fetchImpl = fakeFetch();
  const client = new MasterClient(config(), { fetchImpl });

  client.appendLog("t1", "stdout", "out\n");
  client.appendLog("t1", "stderr", "err\n");
  await tick();

  const streams = fetchImpl.calls.map((call) => call.body.stream).sort();
  assert.deepEqual(streams, ["stderr", "stdout"]);
});

test("a completion report is retried until it lands", async () => {
  const fetchImpl = fakeFetch([
    { throw: "ECONNREFUSED" },
    { throw: "ECONNREFUSED" },
    { ok: true },
  ]);
  const client = new MasterClient(config(), { fetchImpl });

  await client.finish("t1", 0);

  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(fetchImpl.calls.at(-1).body, {
    workerId: client.config.workerId,
    exitCode: 0,
  });
});

test("a rejected payload is not retried", async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 404, text: "task not found" }]);
  const client = new MasterClient(config(), { fetchImpl });

  await assert.rejects(() => client.finish("gone", 0), /404/);
  assert.equal(fetchImpl.calls.length, 1, "a 404 will stay a 404");
});

test("a report that never lands eventually gives up rather than hanging", async () => {
  const fetchImpl = fakeFetch(
    Array.from({ length: 10 }, () => ({ throw: "ECONNREFUSED" })),
  );
  const client = new MasterClient(config({ REPORT_RETRIES: "2" }), { fetchImpl });

  await assert.rejects(() => client.finish("t1", 1), /ECONNREFUSED/);
  assert.equal(fetchImpl.calls.length, 3, "the initial attempt plus two retries");
});

test("the shared token is attached to every request", async () => {
  const fetchImpl = fakeFetch();
  const client = new MasterClient(config(), { fetchImpl });

  await client.register();

  assert.equal(fetchImpl.calls[0].headers.authorization, "Bearer tok");
});

test("pending output is flushed before the completion report", async () => {
  const fetchImpl = fakeFetch();
  const client = new MasterClient(config({ LOG_FLUSH_INTERVAL_MS: "5000" }), {
    fetchImpl,
  });

  client.appendLog("t1", "stdout", "last words\n");
  await client.finish("t1", 0);

  const paths = fetchImpl.calls.map((call) => call.url.split("/").at(-1));
  assert.deepEqual(paths, ["log", "finish"], "logs must not arrive after the result");
});
