# Nimbus Dashboard

The scheduler's web UI: Vue 3 + TypeScript + Vite, no component framework.

```bash
npm install          # from the repository root (npm workspaces)
npm run dev:ui       # http://localhost:5173
```

Copy `.env.example` to `.env.local` and set `VITE_API_URL` /
`VITE_SCHEDULER_TOKEN` to point at your master.

## How it is put together

| Path | Responsibility |
|---|---|
| `src/store/cluster.ts` | Reactive state, entity maps and derived metrics |
| `src/api/client.ts` | REST calls (create, cancel, logs) |
| `src/api/socket.ts` | WebSocket: snapshot, incremental events, reconnect |
| `src/components/` | Presentational components, one concern each |
| `src/composables/` | `useNow`, `useAutoScroll`, `useToast` |
| `src/styles/` | `base` (tokens, buttons, forms), `layout`, `components` |

Two things worth knowing:

- The master sends **one snapshot then deltas**, so workers and tasks live in
  `Map`s keyed by id and are patched in place rather than replaced.
- Relative timestamps use the master's clock (`serverTime` from each frame)
  rather than the browser's, so "heartbeat 3s ago" stays honest under clock skew.

See the [root README](../readme.md) for the whole system.
