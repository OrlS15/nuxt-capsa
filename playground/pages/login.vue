<script setup lang="ts">
const { client } = useCapsaSession()

const mode = ref<'login' | 'register'>('login')
const name = ref('')
const email = ref('')
const password = ref('')
const error = ref('')
const pending = ref(false)

/** Signs in, or creates the account and signs in, then goes to the abilities page. */
async function submit() {
  pending.value = true
  error.value = ''

  const result = mode.value === 'login'
    ? await client.signIn.email({ email: email.value, password: password.value })
    : await client.signUp.email({ name: name.value, email: email.value, password: password.value })

  pending.value = false

  if (result.error) error.value = result.error.message ?? result.error.statusText
  else await navigateTo('/abilities')
}
</script>

<template>
  <div>
    <h1>{{ mode === 'login' ? 'Sign in' : 'Create an account' }}</h1>

    <form @submit.prevent="submit">
      <input
        v-if="mode === 'register'"
        v-model="name"
        autocomplete="name"
        placeholder="Name"
        required
      >
      <input
        v-model="email"
        type="email"
        autocomplete="email"
        placeholder="Email"
        required
      >
      <input
        v-model="password"
        type="password"
        :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
        placeholder="Password, 8 characters or more"
        minlength="8"
        required
      >
      <button
        type="submit"
        :disabled="pending"
      >
        {{ mode === 'login' ? 'Sign in' : 'Create account' }}
      </button>
    </form>

    <p v-if="error">
      {{ error }}
    </p>

    <p>
      <a
        v-if="mode === 'login'"
        href="#"
        @click.prevent="mode = 'register'"
      >No account yet? Create one</a>
      <a
        v-else
        href="#"
        @click.prevent="mode = 'login'"
      >Already have an account? Sign in</a>
    </p>
  </div>
</template>
