<script setup lang="ts">
const { user, loggedIn, resolved } = useCapsaSession()
</script>

<template>
  <p v-if="!resolved">
    Loading…
  </p>
  <p v-else-if="loggedIn">
    Signed in as {{ user?.name }}, on the {{ user?.plan }} plan
  </p>
  <p v-else>
    Not signed in
  </p>
</template>
