<script setup lang="ts">
const { can } = useCapsaSession()
// Built once per app: every call hands back the same object.
const same = useCapsaSession() === useCapsaSession()
const draft = { authorId: 'someone-else', published: false }
</script>

<template>
  <div>
    <Can do="schedule">
      <p>can schedule</p>
      <template #denied="{ code }">
        <p>schedule denied: {{ code }}</p>
      </template>
    </Can>
    <Cannot
      v-slot="{ code }"
      do="post.edit"
      :with="draft"
    >
      <p>cannot edit: {{ code }}</p>
    </Cannot>
    <p v-if="can('projects.create', 1)">
      can create projects
    </p>
    <p>is Ada: {{ can(user => user.name === 'Ada') }}</p>
    <p>same session object: {{ same }}</p>
    <Can
      do="post.edit"
      :with="undefined"
    >
      <p>edit before the post arrives</p>
      <template #denied>
        <p>denied before the post arrives</p>
      </template>
    </Can>
    <p v-if="can('post.edit', undefined) === undefined">
      unknown before the post arrives
    </p>
  </div>
</template>
