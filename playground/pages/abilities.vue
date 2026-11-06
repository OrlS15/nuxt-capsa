<script setup lang="ts">
const { user, signOut, client, can } = useCapsaSession()

const email = ref('ada@example.com')
const password = ref('password1234')
const count = ref(2)
const apiAnswer = ref<string>()

// One note of the visitor's, and two of someone else.
const notes = computed(() => [
  { title: 'My draft', authorId: user.value?.id ?? 'me', published: false },
  { title: 'Someone else\'s draft', authorId: 'someone-else', published: false },
  { title: 'Someone else\'s published note', authorId: 'someone-else', published: true },
])

/** Signs in, or signs up the first time. */
async function enter() {
  const signedIn = await client.signIn.email({ email: email.value, password: password.value })

  if (signedIn.error) await client.signUp.email({ email: email.value, password: password.value, name: email.value.split('@')[0]! })
}

/** Calls the API the rules protect, and shows its answer: the refusal arrives as <Can>'s #denied receives it. */
async function callApi(check: string) {
  try {
    await $fetch(`/api/abilities/${check}`, { query: { count: count.value } })
    apiAnswer.value = 'allowed'
  }
  catch (error) {
    apiAnswer.value = JSON.stringify((error as { data: { data: unknown } }).data.data)
  }
}
</script>

<template>
  <div>
    <section>
      <p v-if="user">
        Signed in as {{ user.email }}, on the {{ user.plan }} plan
        <button @click="signOut()">
          Sign out
        </button>
      </p>
      <form
        v-else
        @submit.prevent="enter"
      >
        <input
          v-model="email"
          type="email"
        >
        <input
          v-model="password"
          type="password"
        >
        <button type="submit">
          Sign in or sign up
        </button>
      </form>
    </section>

    <section>
      <h2>Notes</h2>
      <template
        v-for="note in notes"
        :key="note.title"
      >
        <Can
          do="notes.view"
          :with="note"
        >
          <p>
            {{ note.title }}
            <Can
              do="notes.edit"
              :with="note"
            >
              <button>Edit</button>
              <template #denied="{ code }">
                <small>cannot edit: {{ code }}</small>
              </template>
            </Can>
          </p>
          <template #denied="{ code }">
            <p>(a note hidden from you: {{ code }})</p>
          </template>
        </Can>
      </template>
    </section>

    <section>
      <h2>Plan</h2>
      <Can do="schedule">
        <p>You can schedule notes.</p>
        <button @click="client.updateUser({ plan: 'free' })">
          Back to free
        </button>
        <template #denied="{ code }">
          <p>
            Scheduling: {{ code }}
            <button
              v-if="user"
              @click="client.updateUser({ plan: 'pro' })"
            >
              Become Pro
            </button>
          </p>
        </template>
      </Can>
    </section>

    <section>
      <h2>Limit</h2>
      <p>
        Notes you have: {{ count }}
        <button @click="count++">
          +1
        </button>
        <button @click="count = Math.max(0, count - 1)">
          -1
        </button>
      </p>
      <Can
        do="notes.create"
        :with="count"
      >
        <button>New note</button>
        <template #denied="refusal">
          <p v-if="refusal.code === 'LIMIT_REACHED'">
            You reached the limit of {{ refusal.details.limit }} notes.
          </p>
          <p v-else>
            {{ refusal.code }}
          </p>
        </template>
      </Can>
      <p>can('notes.create', count) in the template: {{ can('notes.create', count) }}</p>
    </section>

    <section>
      <h2>The server enforces the same rules</h2>
      <button @click="callApi('schedule')">
        Call schedule
      </button>
      <button @click="callApi('create')">
        Call create with {{ count }} notes
      </button>
      <pre v-if="apiAnswer">{{ apiAnswer }}</pre>
    </section>
  </div>
</template>
