<template>
  <div v-if="state.workers.length" class="worker-grid">
    <worker-card v-for="worker in state.workers" :key="worker.id" :worker="worker" />
  </div>
  <div v-else class="empty-state compact"><span>◇</span><strong>No workers connected</strong><p>Start a worker to add compute capacity.</p></div>
</template>

<script setup lang="ts">
import { state } from "../store/state";
import WorkerCard from "./WorkerCard.vue";
</script>
