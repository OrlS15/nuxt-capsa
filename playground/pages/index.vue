<template>
  <pre>{{ a }}</pre>
</template>

<script setup>
const a = await $fetch('/api/test')
</script>
