<script setup lang="ts">
import EmptyState from "./EmptyState.vue";
import WorkerCard from "./WorkerCard.vue";
import { workerList } from "../store/cluster";
</script>

<template>
  <div v-if="workerList.length" class="worker-grid">
    <WorkerCard v-for="worker in workerList" :key="worker.id" :worker="worker" />
  </div>

  <EmptyState
    v-else
    compact
    icon="◇"
    title="No workers connected"
    description="Start a worker process to add compute capacity to the cluster."
  />
</template>
