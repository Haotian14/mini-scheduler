<template>
  <el-table :data="state.tasks" style="margin-top: 20px">
    <el-table-column prop="id" label="Task ID" />
    <el-table-column prop="status" label="Status" />
    <el-table-column prop="assignedWorkerId" label="Worker" />
    <el-table-column label="Action">
      <template #default="{ row }">
        <el-button
          v-if="row.status === 'RUNNING'"
          size="small"
          @click="openLog(row.id)"
        >
          Logs
        </el-button>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import { state } from "../store/state";
import { subscribeLog } from "../api/ws";

function openLog(taskId: string) {
  state.activeTaskId = taskId;
  subscribeLog(taskId);
}
</script>
