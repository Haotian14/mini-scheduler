<template>
  <el-card :class="{ offline: worker.status === 'OFFLINE' }">
    <h4>{{ worker.id }}</h4>
    <p>Status: {{ worker.status }}</p>

    <p>CPU: {{ worker.cpuUsed }}/{{ worker.cpuTotal }}</p>
    <el-progress :percentage="cpuPercent" />

    <p>MEM: {{ worker.memUsed }}/{{ worker.memTotal }} GB</p>
    <el-progress :percentage="memPercent" status="success" />
  </el-card>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ worker: any }>();

const clamp = (n: number) => Math.max(0, Math.min(100, n));

const cpuPercent = computed(() => {
  const total = Number(props.worker.cpuTotal) || 0;
  const used = Number(props.worker.cpuUsed) || 0;
  if (total <= 0) return 0;
  return clamp(Math.round((used / total) * 100));
});

const memPercent = computed(() => {
  const total = Number(props.worker.memTotal) || 0;
  const used = Number(props.worker.memUsed) || 0;
  if (total <= 0) return 0;
  return clamp(Math.round((used / total) * 100));
});
</script>

<style scoped>
.offline {
  opacity: 0.4;
}
</style>
