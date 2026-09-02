import { reactive } from "vue";

export interface Toast {
  id: number;
  message: string;
  tone: "success" | "error";
}

const DISPLAY_MS = 4000;

export const toasts = reactive<Toast[]>([]);
let nextId = 1;

export function notify(message: string, tone: Toast["tone"] = "success") {
  const toast: Toast = { id: nextId++, message, tone };
  toasts.push(toast);
  window.setTimeout(() => dismiss(toast.id), DISPLAY_MS);
  return toast.id;
}

export function dismiss(id: number) {
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index !== -1) toasts.splice(index, 1);
}
