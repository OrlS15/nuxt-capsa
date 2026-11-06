<script setup lang="ts">
const { client } = useCapsaSession()
const email = ref('')
const password = ref('')
const error = ref('')

async function login() {
  const result = await client.signIn.email({ email: email.value, password: password.value })

  if (result.error) error.value = result.error.message ?? 'Could not sign in'
  else await navigateTo('/dashboard')
}
</script>

<template>
  <form @submit.prevent="login">
    <input
      v-model="email"
      type="email"
      autocomplete="email"
      placeholder="Email"
    >
    <input
      v-model="password"
      type="password"
      autocomplete="current-password"
      placeholder="Password"
    >
    <button type="submit">
      Sign in
    </button>
    <p v-if="error">
      {{ error }}
    </p>
  </form>
</template>
