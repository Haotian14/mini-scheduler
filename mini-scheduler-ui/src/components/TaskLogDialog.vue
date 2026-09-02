<script setup lang="ts">
import { computed, ref, watch } from "vue";

import BaseModal from "./BaseModal.vue";
import { unsubscribeLog } from "../api/socket";
import { useAutoScroll } from "../composables/useAutoScroll";
import { store } from "../store/cluster";

const task = computed(() => store.tasks.get(store.activeTaskId) ?? null);
const lines = computed(() => store.logs.get(store.activeTaskId) ?? []);

const container = ref<HTMLElement | null>(null);
const { following, onScroll, scrollToBottom } = useAutoScroll(container);

watch(
  () => lines.value.length,
  () => scrollToBottom(),
);
watch(
  () => store.activeTaskId,
  (taskId) => {
    if (taskId) scrollToBottom({ force: true });
  },
);

function close() {
  store.activeTaskId = "";
  unsubscribeLog();
}
</script>

<template>
  <BaseModal
    :open="Boolean(store.activeTaskId)"
    :title="task ? `Task output · ${task.status.toLowerCase()}` : 'Task output'"
    :subtitle="task?.command ?? store.activeTaskId"
    width="820px"
    @close="close"
  >
    <div ref="container" class="log-box" @scroll="onScroll">
      <p v-if="!lines.length" class="log-empty">Waiting for output…</p>
      <pre v-for="(line, index) in lines" :key="index">
<span class="log-gutter">{{ String(index + 1).padStart(3, "0") }}</span>{{ line }}</pre>
    </div>

    <template #footer>
      <span class="log-footnote">
        {{ lines.length }} line(s)
        <template v-if="task">
          · attempt {{ task.attempts }}/{{ task.maxAttempts }}</template
        >
      </span>
      <button
        v-if="!following"
        class="secondary"
        @click="scrollToBottom({ force: true })"
      >
        Jump to latest
      </button>
      <button class="secondary" @click="close">Close</button>
    </template>
  </BaseModal>
</template>
