<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">N</span><div><strong>Nimbus</strong><small>Scheduler</small></div></div>
      <nav>
        <a class="nav-item active"><span class="nav-icon">⌂</span>Overview</a>
        <a class="nav-item"><span class="nav-icon">⌘</span>Tasks <span class="nav-count">{{ activeTasks }}</span></a>
        <a class="nav-item"><span class="nav-icon">◇</span>Workers</a>
        <p>MANAGE</p>
        <a class="nav-item"><span class="nav-icon">◎</span>Activity</a>
        <a class="nav-item"><span class="nav-icon">⚙</span>Settings</a>
      </nav>
      <div class="sidebar-foot">
        <div class="health"><span class="pulse"></span><div><strong>System healthy</strong><small>All services operational</small></div></div>
        <div class="profile"><div class="avatar">AM</div><div><strong>Alex Morgan</strong><small>Administrator</small></div><button>•••</button></div>
      </div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div><p class="eyebrow">WORKSPACE / PRODUCTION</p><h1>Good morning, Alex <span>👋</span></h1><p>Here’s what’s happening with your compute cluster today.</p></div>
        <div class="header-actions"><div class="connection" :class="state.connectionStatus"><span></span>{{ connectionLabel }}</div><button class="icon-button" aria-label="Notifications">♢<i></i></button><button class="primary" @click="showCreate = true"><b>＋</b> New task</button></div>
      </header>

      <section class="metrics-grid">
        <article class="metric-card"><div class="metric-icon violet">◇</div><div><span>Active workers</span><strong>{{ onlineWorkers }}<small> / {{ state.workers.length }}</small></strong><p class="positive">↗ {{ workerAvailability }}% available</p></div></article>
        <article class="metric-card"><div class="metric-icon blue">⌁</div><div><span>Running tasks</span><strong>{{ runningTasks }}</strong><p><b>{{ pendingTasks }}</b> waiting in queue</p></div></article>
        <article class="metric-card"><div class="metric-icon green">✓</div><div><span>Success rate</span><strong>{{ successRate }}%</strong><p class="positive">↗ Last 24 hours</p></div></article>
        <article class="metric-card"><div class="metric-icon amber">◴</div><div><span>Avg. duration</span><strong>{{ averageDuration }}</strong><p>Across completed tasks</p></div></article>
      </section>

      <section class="content-section">
        <div class="section-heading"><div><h2>Worker fleet</h2><p>Real-time resource utilization across your cluster</p></div><button class="ghost">View all workers →</button></div>
        <cluster-panel />
      </section>

      <section class="content-section task-section">
        <div class="section-heading"><div><h2>Recent tasks</h2><p>Latest jobs dispatched across the cluster</p></div></div>
        <task-table @create="showCreate = true" />
      </section>
    </main>

    <task-log-modal />
    <create-task-dialog v-model="showCreate" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import ClusterPanel from "./components/ClusterPanel.vue";
import TaskTable from "./components/TaskTable.vue";
import TaskLogModal from "./components/TaskLogModal.vue";
import CreateTaskDialog from "./components/CreateTaskDialog.vue";
import { connectWS } from "./api/ws";
import { state } from "./store/state";

const showCreate = ref(false);
const onlineWorkers = computed(() => state.workers.filter((worker) => worker.status === "ONLINE").length);
const workerAvailability = computed(() => state.workers.length ? Math.round(onlineWorkers.value / state.workers.length * 100) : 0);
const runningTasks = computed(() => state.tasks.filter((task) => task.status === "RUNNING").length);
const pendingTasks = computed(() => state.tasks.filter((task) => task.status === "PENDING").length);
const activeTasks = computed(() => runningTasks.value + pendingTasks.value);
const completedTasks = computed(() => state.tasks.filter((task) => ["SUCCESS", "FAILED"].includes(task.status)));
const successRate = computed(() => completedTasks.value.length ? Math.round(completedTasks.value.filter((task) => task.status === "SUCCESS").length / completedTasks.value.length * 100) : 100);
const averageDuration = computed(() => {
  const durations = completedTasks.value.filter((task) => task.startedAt && task.finishedAt).map((task) => task.finishedAt! - task.startedAt!);
  if (!durations.length) return "—";
  const seconds = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
});
const connectionLabel = computed(() => ({ connected: "Live", connecting: "Connecting", disconnected: "Offline" })[state.connectionStatus]);

connectWS();
</script>
