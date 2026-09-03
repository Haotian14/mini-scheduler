<script setup lang="ts">
import { ref } from "vue";

import { backend } from "../api/backend";
import { notify } from "../composables/useToast";

const REPO_URL = "https://github.com/Haotian14/mini-scheduler";

const autoSubmit = ref(backend.demo?.autoSubmitEnabled ?? true);

function crashWorker() {
  const workerId = backend.demo?.crashWorker();
  notify(
    workerId
      ? `${workerId} stopped answering — watch it go OFFLINE and its work re-queue`
      : "Every node is already offline",
    workerId ? "success" : "error",
  );
}

function queueLargeJob() {
  backend.demo?.queueLargeJob();
  notify("Queued a job that needs a whole node — smaller jobs backfill until it ages");
}

function toggleAutoSubmit() {
  autoSubmit.value = !autoSubmit.value;
  backend.demo?.setAutoSubmit(autoSubmit.value);
}
</script>

<template>
  <aside class="demo-bar">
    <div class="demo-copy">
      <strong>Simulated cluster</strong>
      <p>
        There is no server behind this page. It runs the scheduler's real
        <code>ClusterState</code> and <code>Scheduler</code> modules in your browser
        against a fake fleet, so placement, retries and failover are the production code
        paths.
        <a :href="REPO_URL" target="_blank" rel="noreferrer">Source</a>
      </p>
    </div>

    <div class="demo-actions">
      <button class="secondary" @click="crashWorker">Crash a worker</button>
      <button class="secondary" @click="queueLargeJob">Queue a whole-node job</button>
      <button class="secondary" @click="toggleAutoSubmit">
        {{ autoSubmit ? "Pause traffic" : "Resume traffic" }}
      </button>
    </div>
  </aside>
</template>
