<script setup lang="ts">
import { ref } from 'vue'
import App from './App.vue'
import AccessTokenGate from './components/AccessTokenGate.vue'
import { hasAccessToken } from './lib/api'

const unlocked = ref(hasAccessToken())
</script>

<template>
  <App v-if="unlocked" />
  <AccessTokenGate
    v-else
    @unlocked="unlocked = true"
  />
</template>
