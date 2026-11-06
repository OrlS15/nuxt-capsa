<script setup lang="ts">
const { data: users, refresh } = await useFetch('/api/users')
const { data: products } = await useFetch('/api/products')
const { data: visits } = await useFetch('/api/visits', { method: 'POST', body: { path: '/' } })

const name = ref('')
const email = ref('')

async function addUser() {
  await $fetch('/api/users', { method: 'POST', body: { name: name.value, email: email.value } })
  name.value = email.value = ''
  await refresh()
}
</script>

<template>
  <div>
    <h1>Database</h1>

    <h2>Users and their comments (default, relations)</h2>
    <ul>
      <li
        v-for="user in users"
        :key="user.id"
      >
        {{ user.name }} &lt;{{ user.email }}&gt;: {{ user.comments.map(comment => comment.content).join(', ') || 'no comments' }}
      </li>
    </ul>
    <form @submit.prevent="addUser">
      <input
        v-model="name"
        placeholder="Name"
        required
      >
      <input
        v-model="email"
        type="email"
        placeholder="Email"
        required
      >
      <button type="submit">
        Add user
      </button>
    </form>

    <h2>Products (a table from the base layer)</h2>
    <p>{{ products?.length ? products.map(product => product.name).join(', ') : 'none yet' }}</p>

    <h2>Visits (analytics, a second database on SQLite)</h2>
    <p>This page was opened {{ visits }} times.</p>
  </div>
</template>
