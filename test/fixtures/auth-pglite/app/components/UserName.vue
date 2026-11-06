<script setup lang="ts">
const { user, resolved } = useCapsaSession()
</script>

<template>
  <span class="user-name">{{ resolved ? (user?.name ?? 'anonymous') : 'loading' }}</span>
</template>
