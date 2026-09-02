import { timingSafeEqual } from "node:crypto";

/**
 * CORS with an explicit allow-list.
 *
 * The default is the Vite dev origin rather than `*`: this API executes shell
 * commands, so a wildcard would let any page the developer happens to open
 * post tasks to their own machine.
 */
export function corsMiddleware(origins) {
  const allowAll = origins.includes("*");
  const allowed = new Set(origins);

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (allowAll) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  };
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function extractToken(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  const custom = req.headers["x-scheduler-token"];
  return typeof custom === "string" ? custom : "";
}

/**
 * Shared-secret gate. When no token is configured the middleware is a no-op,
 * which keeps `npm run dev` frictionless; `loadConfig` refuses to start in
 * production without one.
 */
export function authMiddleware(token) {
  if (!token) return (_req, _res, next) => next();
  return (req, res, next) => {
    if (safeEqual(extractToken(req), token)) return next();
    return res.status(401).json({ error: "invalid or missing scheduler token" });
  };
}

/** Same check for WebSocket upgrades, where the token travels in the query. */
export function isAuthorizedUpgrade(request, token) {
  if (!token) return true;
  const url = new URL(request.url ?? "/", "http://localhost");
  const provided =
    url.searchParams.get("token") ||
    (typeof request.headers["sec-websocket-protocol"] === "string"
      ? request.headers["sec-websocket-protocol"]
      : "");
  return safeEqual(provided, token);
}
