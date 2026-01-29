<template>
  <el-dialog v-model="visible" title="Live Logs" width="60%" @close="close">
    <div ref="container" class="log-box" @scroll="onScroll">
      <pre v-for="(line, i) in logs" :key="i">{{ line }}</pre>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { state } from "../store/state";
import { unsubscribeLog } from "../api/ws";
import { useAutoScroll } from "../composables/useAutoScroll";

const visible = computed(() => !!state.activeTaskId);
const logs = computed(() => state.logs.get(state.activeTaskId) || []);

const { container, onScroll, scrollToBottom } = useAutoScroll();

watch(logs, () => scrollToBottom());

function close() {
  state.activeTaskId = "";
  unsubscribeLog();
}
</script>

<style scoped>
.log-box {
  height: 400px;
  overflow: auto;
  background: #111;
  color: #0f0;
  padding: 8px;
}
</style>
