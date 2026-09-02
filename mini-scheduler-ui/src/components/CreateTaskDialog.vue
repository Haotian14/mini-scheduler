<script setup lang="ts">
import { reactive, ref, watch } from "vue";

import BaseModal from "./BaseModal.vue";
import { createTask } from "../api/client";
import { notify } from "../composables/useToast";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const form = reactive({ command: "", cpu_required: 1, mem_required: 1 });
const submitting = ref(false);
const error = ref("");

watch(
  () => props.open,
  (open) => {
    if (open) error.value = "";
  },
);

async function submit() {
  if (submitting.value) return;
  error.value = "";

  if (!form.command.trim()) {
    error.value = "A command is required.";
    return;
  }
  if (form.cpu_required <= 0 || form.mem_required <= 0) {
    error.value = "CPU and memory requirements must be greater than zero.";
    return;
  }

  submitting.value = true;
  try {
    await createTask({ ...form, command: form.command.trim() });
    notify("Task added to the queue");
    form.command = "";
    emit("close");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Unable to create task";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    title="Create a new task"
    subtitle="The scheduler places it on the worker that fits it most tightly."
    @close="emit('close')"
  >
    <form id="create-task-form" class="task-form" @submit.prevent="submit">
      <label>
        Command
        <small>Runs through a shell on the assigned worker.</small>
        <textarea
          v-model="form.command"
          rows="4"
          placeholder="node process-data.js --batch latest"
          required
        />
      </label>

      <div class="form-grid">
        <label>
          CPU cores
          <input
            v-model.number="form.cpu_required"
            type="number"
            min="0.1"
            step="0.1"
            required
          />
        </label>
        <label>
          Memory (GB)
          <input
            v-model.number="form.mem_required"
            type="number"
            min="0.1"
            step="0.1"
            required
          />
        </label>
      </div>

      <p v-if="error" class="form-error">{{ error }}</p>
    </form>

    <template #footer>
      <button type="button" class="secondary" @click="emit('close')">Cancel</button>
      <button
        type="submit"
        form="create-task-form"
        class="primary"
        :disabled="submitting"
      >
        {{ submitting ? "Creating…" : "Create task" }}
      </button>
    </template>
  </BaseModal>
</template>
