import { connectWS } from "./api/ws"; connectWS();

<template>
  <el-container style="height: 100vh">
    <el-header>
      <h2>Mini Scheduler Dashboard</h2>
    </el-header>

    <el-main>
      <cluster-panel />
      <task-table />
    </el-main>

    <task-log-modal />
  </el-container>
</template>

<script setup lang="ts">
import ClusterPanel from "./components/ClusterPanel.vue";
import TaskTable from "./components/TaskTable.vue";
import TaskLogModal from "./components/TaskLogModal.vue";

import { connectWS } from "./api/ws";

// ⭐⭐⭐ 关键：建立 WebSocket 连接
connectWS();
</script>
