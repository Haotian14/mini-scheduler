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
const props = defineProps<{ worker: any }>();

const cpuPercent = Math.round(
  (props.worker.cpuUsed / props.worker.cpuTotal) * 100,
);
const memPercent = Math.round(
  (props.worker.memUsed / props.worker.memTotal) * 100,
);
</script>

<style scoped>
.offline {
  opacity: 0.4;
}
</style>
