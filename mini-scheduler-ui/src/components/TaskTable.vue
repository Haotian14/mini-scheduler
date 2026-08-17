<template>
  <div class="table-shell">
    <div class="table-toolbar"><div class="tabs"><button v-for="filter in filters" :key="filter" :class="{ active: activeFilter === filter }" @click="activeFilter = filter">{{ filter }}<span>{{ count(filter) }}</span></button></div><label class="search">⌕<input v-model="query" placeholder="Search tasks" /></label></div>
    <div v-if="filteredTasks.length" class="responsive-table">
      <table><thead><tr><th>Task</th><th>Status</th><th>Worker</th><th>Resources</th><th>Created</th><th></th></tr></thead>
      <tbody><tr v-for="task in filteredTasks" :key="task.id"><td><strong>{{ shortId(task.id) }}</strong><code>{{ task.command }}</code></td><td><span class="task-status" :class="task.status.toLowerCase()"><i></i>{{ formatStatus(task.status) }}</span></td><td><span class="worker-cell">{{ task.assignedWorkerId ? shortId(task.assignedWorkerId) : "Unassigned" }}</span></td><td><span class="resources">{{ task.cpuRequired }} CPU&nbsp; · &nbsp;{{ task.memRequired }} GB</span></td><td><time>{{ formatTime(task.createdAt) }}</time></td><td><button class="more" aria-label="View logs" @click="openLog(task.id)">•••</button></td></tr></tbody></table>
    </div>
    <div v-else class="empty-state"><span>⌘</span><strong>{{ state.tasks.length ? "No matching tasks" : "Your queue is ready" }}</strong><p>{{ state.tasks.length ? "Try another search or status filter." : "Create your first task to start scheduling work." }}</p><button v-if="!state.tasks.length" class="primary" @click="$emit('create')">＋ New task</button></div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { state, type TaskStatus } from "../store/state";
import { subscribeLog } from "../api/ws";
defineEmits<{ create: [] }>();
const filters = ["All", "Running", "Pending", "Completed"] as const;
const activeFilter = ref<(typeof filters)[number]>("All");
const query = ref("");
const filteredTasks = computed(() => [...state.tasks].sort((a, b) => b.createdAt - a.createdAt).filter((task) => {
  const statusMatch = activeFilter.value === "All" || (activeFilter.value === "Completed" ? ["SUCCESS", "FAILED"].includes(task.status) : task.status === activeFilter.value.toUpperCase());
  return statusMatch && `${task.id} ${task.command} ${task.assignedWorkerId}`.toLowerCase().includes(query.value.toLowerCase());
}));
function count(filter: (typeof filters)[number]) { return filter === "All" ? state.tasks.length : filter === "Completed" ? state.tasks.filter((task) => ["SUCCESS", "FAILED"].includes(task.status)).length : state.tasks.filter((task) => task.status === filter.toUpperCase()).length; }
function shortId(id: string) { const pieces = id.split("_"); return pieces.length > 1 ? `${pieces[0]}-${pieces[pieces.length - 1]?.slice(0, 6)}` : id; }
function formatStatus(status: TaskStatus) { return status.charAt(0) + status.slice(1).toLowerCase(); }
function formatTime(timestamp: number) { return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp); }
function openLog(taskId: string) { state.activeTaskId = taskId; subscribeLog(taskId); }
</script>
