<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch, setAccessToken } from '@/lib/api'

const emit = defineEmits<{
  (event: 'unlocked'): void
}>()

const token = ref('')
const isChecking = ref(false)
const error = ref('')

async function submit() {
  const value = token.value.trim()
  if (!value) return

  isChecking.value = true
  error.value = ''
  try {
    setAccessToken(value)
    // Any authenticated route works as a check; /api/creds is cheap.
    await apiFetch('/api/creds')
    emit('unlocked')
  } catch (err) {
    setAccessToken('')
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isChecking.value = false
  }
}
</script>

<template>
  <main class="w-screen h-screen flex flex-col items-center justify-center gap-4 px-6">
    <div class="flex w-full max-w-xs flex-col gap-2 text-center">
      <h1 class="text-xl font-semibold select-none">
        gotohp
      </h1>
      <p class="text-sm text-muted-foreground select-none">
        Enter the access token for your Worker deployment.
      </p>
    </div>
    <div class="flex w-full max-w-xs flex-col gap-2">
      <Label for="access-token">Access token</Label>
      <Input
        id="access-token"
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="APP_ACCESS_TOKEN"
        :disabled="isChecking"
        @keydown.enter="submit"
      />
      <Button
        class="cursor-pointer select-none"
        :disabled="!token.trim() || isChecking"
        @click="submit"
      >
        {{ isChecking ? 'Checking...' : 'Continue' }}
      </Button>
      <p
        v-if="error"
        class="text-sm text-destructive"
      >
        {{ error }}
      </p>
    </div>
  </main>
</template>
