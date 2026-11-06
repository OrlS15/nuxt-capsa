<script setup lang="ts">
const { user, signOut } = useCapsaSession()
</script>

<template>
  <div>
    <h1>Hello {{ user?.name }}</h1>
    <p>Your plan: {{ user?.plan }}</p>
    <button @click="signOut({ redirectTo: '/login' })">
      Sign out
    </button>
  </div>
</template>
