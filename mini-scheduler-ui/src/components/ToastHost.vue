<script setup lang="ts">
import { dismiss, toasts } from "../composables/useToast";
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" role="status" aria-live="polite">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.tone">
        <span>{{ toast.message }}</span>
        <button aria-label="Dismiss" @click="dismiss(toast.id)">×</button>
      </div>
    </div>
  </Teleport>
</template>
