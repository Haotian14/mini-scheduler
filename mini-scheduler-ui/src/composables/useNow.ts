import { onScopeDispose, readonly, ref } from "vue";

/**
 * One shared ticking clock for every relative timestamp on the page. A single
 * interval keeps "12s ago" labels fresh without each component owning a timer.
 */
const now = ref(Date.now());
let subscribers = 0;
let timer: number | undefined;

export function useNow(intervalMs = 1000) {
  subscribers += 1;
  if (subscribers === 1) {
    timer = window.setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  }

  onScopeDispose(() => {
    subscribers -= 1;
    if (subscribers === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  });

  return readonly(now);
}

export function formatAge(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function formatDuration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
