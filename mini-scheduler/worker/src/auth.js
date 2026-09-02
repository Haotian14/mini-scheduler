import { timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Guards `/run` and `/tasks/:id/cancel` with the same shared secret the master
 * uses. Without it, anything able to reach the worker's port could execute
 * arbitrary commands on the node.
 */
export function authMiddleware(token) {
  if (!token) return (_req, _res, next) => next();
  return (req, res, next) => {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : String(req.headers["x-scheduler-token"] ?? "");
    if (safeEqual(provided, token)) return next();
    return res.status(401).json({ error: "invalid or missing scheduler token" });
  };
}
