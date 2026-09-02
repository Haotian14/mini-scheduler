<script setup lang="ts">
import { computed } from "vue";

import { NAVIGATION, type ViewName } from "../navigation";
import { onlineWorkers, store, tasksByStatus, workerList } from "../store/cluster";

defineProps<{ current: ViewName }>();
const emit = defineEmits<{ navigate: [view: ViewName] }>();

const activeTasks = computed(
  () => tasksByStatus.value.PENDING + tasksByStatus.value.RUNNING,
);

const health = computed(() => {
  if (store.connectionStatus !== "connected") {
    return { label: "Disconnected", detail: "Cannot reach the master", tone: "bad" };
  }
  if (!workerList.value.length) {
    return {
      label: "No workers",
      detail: "Start a worker to add capacity",
      tone: "warn",
    };
  }
  if (!onlineWorkers.value) {
    return {
      label: "All workers offline",
      detail: "Nothing can be scheduled",
      tone: "bad",
    };
  }
  return {
    label: "System healthy",
    detail: `${onlineWorkers.value} of ${workerList.value.length} workers online`,
    tone: "good",
  };
});
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark">N</span>
      <div>
        <strong>Nimbus</strong>
        <small>Scheduler</small>
      </div>
    </div>

    <nav>
      <button
        v-for="item in NAVIGATION"
        :key="item.view"
        class="nav-item"
        :class="{ active: current === item.view }"
        @click="emit('navigate', item.view)"
      >
        <span class="nav-icon">{{ item.icon }}</span>
        <span class="nav-label">{{ item.label }}</span>
        <span v-if="item.view === 'tasks' && activeTasks" class="nav-count">
          {{ activeTasks }}
        </span>
        <span v-if="item.view === 'workers' && workerList.length" class="nav-count">
          {{ onlineWorkers }}
        </span>
      </button>
    </nav>

    <div class="sidebar-foot">
      <div class="health" :class="health.tone">
        <span class="pulse"></span>
        <div>
          <strong>{{ health.label }}</strong>
          <small>{{ health.detail }}</small>
        </div>
      </div>
    </div>
  </aside>
</template>
