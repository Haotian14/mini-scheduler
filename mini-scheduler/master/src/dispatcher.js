/**
 * HTTP client used by the master to talk to workers. Every call is bounded by
 * a timeout so a hung worker can never block the scheduling loop.
 */
export function createDispatcher({ token = "", timeoutMs = 5000 } = {}) {
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  async function post(worker, path, body) {
    const response = await fetch(`http://${worker.host}:${worker.port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`worker responded ${response.status} ${detail}`.trim());
    }
    return response.json().catch(() => ({}));
  }

  return {
    dispatch(worker, task) {
      return post(worker, "/run", {
        taskId: task.id,
        command: task.command,
        cpuRequired: task.cpuRequired,
        memRequired: task.memRequired,
        timeoutMs: task.timeoutMs,
      });
    },
    cancel(worker, taskId) {
      return post(worker, `/tasks/${encodeURIComponent(taskId)}/cancel`, {});
    },
  };
}
