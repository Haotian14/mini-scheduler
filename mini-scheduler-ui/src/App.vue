<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import AppSidebar from "./components/AppSidebar.vue";
import CreateTaskDialog from "./components/CreateTaskDialog.vue";
import MetricCard from "./components/MetricCard.vue";
import TaskLogDialog from "./components/TaskLogDialog.vue";
import TaskTable from "./components/TaskTable.vue";
import ToastHost from "./components/ToastHost.vue";
import WorkerFleet from "./components/WorkerFleet.vue";
import { connect } from "./api/socket";
import { type ViewName } from "./navigation";
import { formatDuration } from "./composables/useNow";
import {
  averageDurationMs,
  clusterCapacity,
  onlineWorkers,
  store,
  successRate,
  tasksByStatus,
  workerList,
} from "./store/cluster";

const view = ref<ViewName>("overview");
const showCreate = ref(false);

const CONNECTION_LABELS: Record<typeof store.connectionStatus, string> = {
  connected: "Live",
  connecting: "Connecting",
  disconnected: "Offline",
};

const headings: Record<ViewName, { title: string; subtitle: string }> = {
  overview: {
    title: "Cluster overview",
    subtitle: "Capacity, throughput and recent activity across the cluster.",
  },
  tasks: {
    title: "Tasks",
    subtitle: "Everything the scheduler is holding, running or has finished.",
  },
  workers: {
    title: "Workers",
    subtitle: "Every node that has registered, and what it is currently using.",
  },
};

const cpuUtilisation = computed(() => {
  const { cpuTotal, cpuUsed } = clusterCapacity.value;
  return cpuTotal ? Math.round((cpuUsed / cpuTotal) * 100) : 0;
});

const successRateLabel = computed(() =>
  successRate.value === null ? "—" : `${successRate.value}%`,
);

const averageDurationLabel = computed(() =>
  averageDurationMs.value === null ? "—" : formatDuration(averageDurationMs.value),
);

onMounted(connect);
</script>

<template>
  <div class="app-shell">
    <AppSidebar :current="view" @navigate="view = $event" />

    <main class="main-content">
      <header class="topbar">
        <div>
          <p class="eyebrow">NIMBUS / {{ view.toUpperCase() }}</p>
          <h1>{{ headings[view].title }}</h1>
          <p class="subtitle">{{ headings[view].subtitle }}</p>
        </div>

        <div class="header-actions">
          <div class="connection" :class="store.connectionStatus">
            <span></span>{{ CONNECTION_LABELS[store.connectionStatus] }}
          </div>
          <button class="primary" @click="showCreate = true"><b>＋</b> New task</button>
        </div>
      </header>

      <p v-if="store.connectionStatus === 'disconnected'" class="banner">
        Lost the connection to the master. Reconnecting automatically…
      </p>

      <section v-if="view === 'overview'" class="metrics-grid">
        <MetricCard
          icon="◇"
          tone="violet"
          label="Workers online"
          :value="String(onlineWorkers)"
          :suffix="`/ ${workerList.length}`"
          :hint="`${cpuUtilisation}% of cluster CPU in use`"
        />
        <MetricCard
          icon="⌁"
          tone="blue"
          label="Running tasks"
          :value="String(tasksByStatus.RUNNING)"
          :hint="`${tasksByStatus.PENDING} waiting in the queue`"
          :hint-tone="tasksByStatus.PENDING ? 'warn' : 'neutral'"
        />
        <MetricCard
          icon="✓"
          tone="green"
          label="Success rate"
          :value="successRateLabel"
          :hint="`${tasksByStatus.SUCCESS} succeeded · ${tasksByStatus.FAILED} failed`"
          hint-tone="positive"
        />
        <MetricCard
          icon="◴"
          tone="amber"
          label="Average duration"
          :value="averageDurationLabel"
          hint="Across completed tasks"
        />
      </section>

      <section v-if="view === 'overview' || view === 'workers'" class="content-section">
        <div class="section-heading">
          <div>
            <h2>Worker fleet</h2>
            <p>Live resource utilisation, refreshed by each heartbeat.</p>
          </div>
          <button v-if="view === 'overview'" class="ghost" @click="view = 'workers'">
            View all workers →
          </button>
        </div>
        <WorkerFleet />
      </section>

      <section v-if="view === 'overview' || view === 'tasks'" class="content-section">
        <div class="section-heading">
          <div>
            <h2>{{ view === "overview" ? "Recent tasks" : "All tasks" }}</h2>
            <p>Status, placement and output of every job the master knows about.</p>
          </div>
          <button v-if="view === 'overview'" class="ghost" @click="view = 'tasks'">
            View all tasks →
          </button>
        </div>
        <TaskTable :limit="view === 'overview' ? 8 : 0" @create="showCreate = true" />
      </section>
    </main>

    <TaskLogDialog />
    <CreateTaskDialog :open="showCreate" @close="showCreate = false" />
    <ToastHost />
  </div>
</template>
