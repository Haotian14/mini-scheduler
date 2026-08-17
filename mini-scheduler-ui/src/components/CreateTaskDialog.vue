<template>
  <el-dialog :model-value="modelValue" title="Create a new task" width="520px" class="create-dialog" @close="$emit('update:modelValue', false)">
    <form class="task-form" @submit.prevent="submit"><label>Command<small>The shell command to execute</small><textarea v-model="form.command" rows="4" placeholder="node process-data.js --batch latest" required /></label><div class="form-grid"><label>CPU cores<input v-model.number="form.cpu_required" type="number" min="0.1" step="0.1" required /></label><label>Memory (GB)<input v-model.number="form.mem_required" type="number" min="0.1" step="0.1" required /></label></div><p v-if="error" class="form-error">{{ error }}</p><div class="dialog-actions"><button type="button" class="secondary" @click="$emit('update:modelValue', false)">Cancel</button><button class="primary" :disabled="submitting">{{ submitting ? "Creating…" : "Create task" }}</button></div></form>
  </el-dialog>
</template>
<script setup lang="ts">
import { reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { createTask } from "../api/ws";
defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
const form = reactive({ command: "", cpu_required: 1, mem_required: 1 });
const submitting = ref(false); const error = ref("");
async function submit() { submitting.value = true; error.value = ""; try { await createTask(form); emit("update:modelValue", false); ElMessage.success("Task added to the queue"); form.command = ""; } catch (value) { error.value = value instanceof Error ? value.message : "Unable to create task"; } finally { submitting.value = false; } }
</script>
