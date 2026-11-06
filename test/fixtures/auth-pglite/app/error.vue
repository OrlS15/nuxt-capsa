<script setup lang="ts">
import type { NuxtError } from '#app'

defineProps<{ error: NuxtError<{ code?: string }> }>()
</script>

<template>
  <p>error {{ error.status }}: {{ error.data?.code ?? 'no code' }}</p>
</template>
