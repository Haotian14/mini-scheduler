<template>
  <el-dialog v-model="visible" width="760px" class="log-dialog" @close="close">
    <template #header><div class="log-title"><span>›_</span><div><strong>Task output</strong><small>{{ state.activeTaskId }}</small></div></div></template>
    <div ref="container" class="log-box" @scroll="onScroll"><div v-if="!logs.length" class="log-empty">Waiting for output…</div><pre v-for="(line, index) in logs" :key="index"><span>{{ String(index + 1).padStart(2, "0") }}</span>{{ line }}</pre></div>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, watch } from "vue";
import { state } from "../store/state";
import { unsubscribeLog } from "../api/ws";
import { useAutoScroll } from "../composables/useAutoScroll";
const visible = computed({ get: () => !!state.activeTaskId, set: (value) => { if (!value) close(); } });
const logs = computed(() => state.logs.get(state.activeTaskId) || []);
const { container, onScroll, scrollToBottom } = useAutoScroll();
void container;
watch(() => logs.value.length, scrollToBottom);
function close() { state.activeTaskId = ""; unsubscribeLog(); }
</script>
