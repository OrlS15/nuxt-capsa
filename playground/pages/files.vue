<script setup lang="ts">
// Only signed-in visitors reach this page: capsa.auth.routes sends the others to /login.
const { data, refresh } = await useFetch('/api/files')

const uploading = ref(false)

async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return

  const form = new FormData()
  form.append('file', file)

  uploading.value = true
  await $fetch('/api/files', { method: 'POST', body: form })
  uploading.value = false
  await refresh()
}
</script>

<template>
  <div>
    <h1>Files</h1>

    <input
      type="file"
      :disabled="uploading"
      @change="upload"
    >

    <ul>
      <li
        v-for="file in data?.files"
        :key="file.key"
      >
        {{ file.key.split('/').pop() }} ({{ file.size }} bytes)
        · <a
          :href="file.link"
          target="_blank"
        >signed link</a>
        · <a :href="`/api/files/${file.key}`">download through the server</a>
      </li>
    </ul>

    <p>Calls made through the disk: {{ data?.operations }}</p>
  </div>
</template>
