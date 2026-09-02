<script setup lang="ts">
import { computed } from "vue";

import { formatAge, useNow } from "../composables/useNow";
import { serverNow, type Worker } from "../store/cluster";

const props = defineProps<{ worker: Worker }>();

const now = useNow();

const percentage = (used: number, total: number) =>
  total ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0;

const cpuPercent = computed(() =>
  percentage(props.worker.cpuUsed, props.worker.cpuTotal),
);
const memPercent = computed(() =>
  percentage(props.worker.memUsed, props.worker.memTotal),
);

const heartbeatAge = computed(() => {
  void now.value; // re-evaluate on every tick
  return formatAge(serverNow() - props.worker.lastHeartbeatAt);
});
</script>

<template>
  <article class="worker-card" :class="{ offline: worker.status === 'OFFLINE' }">
    <header class="worker-head">
      <div class="server-icon"><i></i><i></i><i></i></div>
      <div class="worker-identity">
        <strong :title="worker.id">{{ worker.id }}</strong>
        <p>{{ worker.host }}:{{ worker.port }}</p>
      </div>
      <span class="status-pill" :class="worker.status.toLowerCase()">
        <i></i>{{ worker.status === "ONLINE" ? "Healthy" : "Offline" }}
      </span>
    </header>

    <div class="resource">
      <div class="resource-head">
        <span>CPU</span>
        <b>{{ cpuPercent }}%</b>
      </div>
      <div class="progress"><i :style="{ width: `${cpuPercent}%` }"></i></div>
      <small>{{ worker.cpuUsed }} of {{ worker.cpuTotal }} cores</small>
    </div>

    <div class="resource">
      <div class="resource-head">
        <span>Memory</span>
        <b>{{ memPercent }}%</b>
      </div>
      <div class="progress memory"><i :style="{ width: `${memPercent}%` }"></i></div>
      <small>{{ worker.memUsed }} of {{ worker.memTotal }} GB</small>
    </div>

    <footer>
      <span><i></i>{{ worker.runningTasks.length }} running</span>
      <time :datetime="new Date(worker.lastHeartbeatAt).toISOString()">
        Heartbeat {{ heartbeatAge }}
      </time>
    </footer>
  </article>
</template>
