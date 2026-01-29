<template>
  <el-row :gutter="12">
    <el-col :span="6" v-for="w in state.workers" :key="w.id">
      <worker-card :worker="w" />
    </el-col>
  </el-row>
</template>

<script setup lang="ts">
import { state } from "../store/state";
import WorkerCard from "./WorkerCard.vue";
</script>
