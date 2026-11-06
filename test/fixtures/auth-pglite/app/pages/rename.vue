<script setup lang="ts">
const { user, client } = useCapsaSession()
</script>

<template>
  <div>
    <p>Name: {{ user?.name }}</p>
    <button @click="client.updateUser({ name: 'Ada Lovelace' })">
      Rename
    </button>
  </div>
</template>
