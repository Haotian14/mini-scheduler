<script setup lang="ts">
defineProps<{
  icon: string;
  tone: "violet" | "blue" | "green" | "amber";
  label: string;
  value: string;
  suffix?: string;
  hint?: string;
  hintTone?: "positive" | "neutral" | "warn";
}>();
</script>

<template>
  <article class="metric-card">
    <div class="metric-icon" :class="tone">{{ icon }}</div>
    <div class="metric-body">
      <span class="metric-label">{{ label }}</span>
      <strong class="metric-value">
        {{ value }}
        <small v-if="suffix">{{ suffix }}</small>
      </strong>
      <p v-if="hint" class="metric-hint" :class="hintTone ?? 'neutral'">{{ hint }}</p>
    </div>
  </article>
</template>
