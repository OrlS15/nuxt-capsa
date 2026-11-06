<script setup lang="ts">
const { authorize } = useCapsaSession()
const route = useRoute()

// ?count is how many projects the visitor has; without it, the data never arrived.
await authorize('projects.create', route.query.count === undefined ? undefined : Number(route.query.count))
</script>

<template>
  <p>allowed to create a project</p>
</template>
