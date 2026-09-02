<script setup lang="ts">
import { computed, ref } from "vue";

import EmptyState from "./EmptyState.vue";
import { cancelTask } from "../api/client";
import { subscribeLog } from "../api/socket";
import { formatDuration, useNow } from "../composables/useNow";
import { notify } from "../composables/useToast";
import { isTerminal, serverNow, store, taskList, type Task } from "../store/cluster";

const props = withDefaults(defineProps<{ limit?: number }>(), { limit: 0 });
const emit = defineEmits<{ create: [] }>();

const FILTERS = ["All", "Running", "Pending", "Completed", "Failed"] as const;
type Filter = (typeof FILTERS)[number];

const activeFilter = ref<Filter>("All");
const query = ref("");
const cancelling = ref<string>("");

const now = useNow();

function matchesFilter(task: Task, filter: Filter) {
  switch (filter) {
    case "All":
      return true;
    case "Completed":
      return task.status === "SUCCESS";
    case "Failed":
      return task.status === "FAILED" || task.status === "CANCELLED";
    default:
      return task.status === filter.toUpperCase();
  }
}

function matchesQuery(task: Task, needle: string) {
  if (!needle) return true;
  return `${task.id} ${task.command} ${task.assignedWorkerId ?? ""}`
    .toLowerCase()
    .includes(needle);
}

const filteredTasks = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const matched = taskList.value.filter(
    (task) => matchesFilter(task, activeFilter.value) && matchesQuery(task, needle),
  );
  return props.limit ? matched.slice(0, props.limit) : matched;
});

const counts = computed(() =>
  Object.fromEntries(
    FILTERS.map((filter) => [
      filter,
      taskList.value.filter((task) => matchesFilter(task, filter)).length,
    ]),
  ),
);

function shortId(id: string) {
  const parts = id.split("_");
  return parts.length > 1 ? `${parts[0]}-${parts.at(-1)?.slice(0, 6)}` : id;
}

function formatStatus(status: Task["status"]) {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

/** Elapsed time for running tasks, total duration for finished ones. */
function elapsed(task: Task) {
  void now.value;
  if (!task.startedAt) return "—";
  const end = task.finishedAt ?? serverNow();
  return formatDuration(end - task.startedAt);
}

function openLogs(taskId: string) {
  store.activeTaskId = taskId;
  void subscribeLog(taskId);
}

async function requestCancel(task: Task) {
  cancelling.value = task.id;
  try {
    await cancelTask(task.id);
    notify(`Cancelled ${shortId(task.id)}`);
  } catch (error) {
    notify(error instanceof Error ? error.message : "Unable to cancel task", "error");
  } finally {
    cancelling.value = "";
  }
}
</script>

<template>
  <div class="table-shell">
    <div class="table-toolbar">
      <div class="tabs">
        <button
          v-for="filter in FILTERS"
          :key="filter"
          :class="{ active: activeFilter === filter }"
          @click="activeFilter = filter"
        >
          {{ filter }}
          <span>{{ counts[filter] }}</span>
        </button>
      </div>

      <label class="search">
        <span aria-hidden="true">⌕</span>
        <input v-model="query" placeholder="Search id, command or worker" />
      </label>
    </div>

    <div v-if="filteredTasks.length" class="responsive-table">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Worker</th>
            <th>Resources</th>
            <th>Duration</th>
            <th>Created</th>
            <th><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in filteredTasks" :key="task.id">
            <td class="task-cell">
              <strong>{{ shortId(task.id) }}</strong>
              <code :title="task.command">{{ task.command }}</code>
            </td>

            <td>
              <span class="task-status" :class="task.status.toLowerCase()">
                <i></i>{{ formatStatus(task.status) }}
              </span>
              <span v-if="task.attempts > 1" class="attempt-badge">
                attempt {{ task.attempts }}/{{ task.maxAttempts }}
              </span>
              <small v-if="task.lastError" class="task-error" :title="task.lastError">
                {{ task.lastError }}
              </small>
            </td>

            <td>
              {{ task.assignedWorkerId ? shortId(task.assignedWorkerId) : "Unassigned" }}
            </td>
            <td class="nowrap">{{ task.cpuRequired }} CPU · {{ task.memRequired }} GB</td>
            <td class="nowrap">{{ elapsed(task) }}</td>
            <td class="nowrap">
              <time :datetime="new Date(task.createdAt).toISOString()">
                {{ formatTime(task.createdAt) }}
              </time>
            </td>

            <td class="actions">
              <button class="link" @click="openLogs(task.id)">Logs</button>
              <button
                v-if="!isTerminal(task)"
                class="link danger"
                :disabled="cancelling === task.id"
                @click="requestCancel(task)"
              >
                {{ cancelling === task.id ? "Cancelling…" : "Cancel" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <EmptyState
      v-else
      icon="⌘"
      :title="taskList.length ? 'No matching tasks' : 'Your queue is ready'"
      :description="
        taskList.length
          ? 'Try another search term or status filter.'
          : 'Create your first task to start scheduling work.'
      "
    >
      <button v-if="!taskList.length" class="primary" @click="emit('create')">
        <b>＋</b> New task
      </button>
    </EmptyState>
  </div>
</template>
