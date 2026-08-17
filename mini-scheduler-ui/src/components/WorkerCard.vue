<template>
  <article class="worker-card" :class="{ offline: worker.status === 'OFFLINE' }">
    <div class="worker-head"><div class="server-icon"><i></i><i></i><i></i></div><div><strong>{{ worker.id }}</strong><p>{{ worker.host || "Local node" }}</p></div><span class="status-pill" :class="worker.status.toLowerCase()"><i></i>{{ worker.status === "ONLINE" ? "Healthy" : "Offline" }}</span></div>
    <div class="resource"><div><span>CPU usage</span><b>{{ cpuPercent }}%</b></div><div class="progress"><i :style="{ width: `${cpuPercent}%` }"></i></div><small>{{ worker.cpuUsed }} of {{ worker.cpuTotal }} cores</small></div>
    <div class="resource"><div><span>Memory</span><b>{{ memPercent }}%</b></div><div class="progress memory"><i :style="{ width: `${memPercent}%` }"></i></div><small>{{ worker.memUsed }} of {{ worker.memTotal }} GB</small></div>
    <footer><span><i></i>{{ worker.runningTasks?.length || 0 }} active tasks</span><time>Updated {{ heartbeatAge }}</time></footer>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { Worker } from "../store/state";
const props = defineProps<{ worker: Worker }>();
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const cpuPercent = computed(() => props.worker.cpuTotal ? clamp(Math.round(props.worker.cpuUsed / props.worker.cpuTotal * 100)) : 0);
const memPercent = computed(() => props.worker.memTotal ? clamp(Math.round(props.worker.memUsed / props.worker.memTotal * 100)) : 0);
const heartbeatAge = computed(() => {
  const seconds = Math.max(0, Math.round((Date.now() - props.worker.lastHeartbeatAt) / 1000));
  return seconds < 5 ? "just now" : `${seconds}s ago`;
});
</script>
