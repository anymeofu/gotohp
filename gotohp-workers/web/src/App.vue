<script setup lang="ts">
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useColorMode } from '@vueuse/core'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { UserPlus } from '@lucide/vue'
import { credsApi, settingsApi } from './lib/api'
import { collectDroppedItems } from './lib/dropFiles'
import Button from "./components/ui/button/Button.vue"
import GoogleAccountSelect from './components/GoogleAccountSelect.vue'
import GoogleAuthSetup from "./components/GoogleAuthSetup.vue"
import './index.css'
import SettingsPanel from "./SettingsPanel.vue"
import Upload from './Upload.vue'
import { uploadManager, type UploadItem } from './utils/UploadManager'
import Toaster from './components/ui/sonner/Sonner.vue'

import { toast } from "vue-sonner"

useColorMode().value = "dark"

const { state: uploadState } = uploadManager
const copyButtonText = ref('Copy as JSON');

// Drag state for the three drop zones
const isDraggingFiles = ref(false)

// Album upload flow state
const showAlbumInput = ref(false)
const pendingItems = ref<UploadItem[]>([])
const pendingFileCount = ref(0)

const selectedOption = ref('')
const options = ref<string[]>([])
const accountNeedsTokenBinding = ref<Record<string, boolean>>({})
const albumNameOrKey = ref('')
const tokenBindingEmail = ref('')
const isAccountSetupOpen = ref(false)
const removingAccount = ref('')
const exportingAccount = ref('')

watch(selectedOption, async (newValue) => {
  if (newValue) {
    try {
      await credsApi.select(newValue)
      updateTokenBindingPrompt(newValue)
    } catch (error) {
      console.error('Failed to update selected value:', error)
      toast.error('Failed to update selected account.')
    }
  } else {
    tokenBindingEmail.value = ''
  }
})

function updateTokenBindingPrompt(email: string) {
  tokenBindingEmail.value = accountNeedsTokenBinding.value[email] ? email : ''
}

async function refreshCredentials() {
  try {
    const state = await credsApi.list()
    const nextNeedsTokenBinding: Record<string, boolean> = {}
    const nextOptions = state.accounts.map(account => {
      nextNeedsTokenBinding[account.email] = account.needsTokenBinding
      return account.email
    })

    accountNeedsTokenBinding.value = nextNeedsTokenBinding
    options.value = nextOptions
    selectedOption.value = state.selected || ''
    if (state.selected) {
      updateTokenBindingPrompt(state.selected)
    } else {
      tokenBindingEmail.value = ''
    }
  } catch (error) {
    console.error('Failed to refresh Google accounts:', error)
    toast.error('Could not refresh Google accounts', {
      description: error instanceof Error ? error.message : String(error),
    })
  }
}

async function removeCredentials(email: string) {
  removingAccount.value = email
  try {
    await credsApi.remove(email)

    const removedSelectedAccount = selectedOption.value === email
    await refreshCredentials()
    if (removedSelectedAccount && options.value.length > 0 && !selectedOption.value) {
      selectedOption.value = options.value[0]
    }
    toast.success('Credentials removed.')
    return true
  } catch (error) {
    console.error('Failed to remove credentials:', error)
    toast.error('Failed to remove credentials.')
    return false
  } finally {
    removingAccount.value = ''
  }
}

async function exportCredential(email: string) {
  exportingAccount.value = email
  try {
    const { credential } = await credsApi.export(email)
    await navigator.clipboard.writeText(credential)
    toast.success('Credential copied to clipboard.', {
      description: 'Sensitive: this is a master credential for the Google account. Paste it only into the app you trust.',
    })
  } catch (error) {
    console.error('Failed to export credential:', error)
    toast.error('Failed to export credential.', {
      description: error instanceof Error ? error.message : String(error),
    })
  } finally {
    exportingAccount.value = ''
  }
}

function openAccountSetup() {
  isAccountSetupOpen.value = true
}

onMounted(async () => {
  await refreshCredentials()
})

const handleCopyClick = () => {
  uploadManager.copyResultsAsJson();
  copyButtonText.value = 'Copied!';
  setTimeout(() => copyButtonText.value = 'Copy as JSON', 1000);
};

// Global drag event handlers to detect file dragging
let dragLeaveTimeout: ReturnType<typeof setTimeout> | null = null

const onDragEnter = (e: DragEvent) => {
  if (!e.dataTransfer?.types.includes('Files')) return

  if (dragLeaveTimeout) {
    clearTimeout(dragLeaveTimeout)
    dragLeaveTimeout = null
  }

  isDraggingFiles.value = true
}

const onDragOver = (e: DragEvent) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()

  if (dragLeaveTimeout) {
    clearTimeout(dragLeaveTimeout)
    dragLeaveTimeout = null
  }
}

const onDragLeave = (e: DragEvent) => {
  if (!e.dataTransfer?.types.includes('Files')) return

  if (dragLeaveTimeout) {
    clearTimeout(dragLeaveTimeout)
  }
  dragLeaveTimeout = setTimeout(() => {
    isDraggingFiles.value = false
    dragLeaveTimeout = null
  }, 50)
}

async function handleDropZone(e: DragEvent, dropZone: 'regular' | 'album' | 'auto-album') {
  e.preventDefault()
  if (dragLeaveTimeout) {
    clearTimeout(dragLeaveTimeout)
    dragLeaveTimeout = null
  }
  isDraggingFiles.value = false

  if (!e.dataTransfer) return
  const items = await collectDroppedItems(e.dataTransfer)
  if (items.length === 0) return

  if (dropZone === 'album') {
    pendingItems.value = items
    pendingFileCount.value = items.length
    showAlbumInput.value = true
  } else if (dropZone === 'auto-album') {
    await settingsApi.patch({ albumName: '', albumAutoMode: true })
    await uploadManager.startUpload(items, { albumAutoMode: true })
  } else {
    await settingsApi.patch({ albumName: '', albumAutoMode: false })
    await uploadManager.startUpload(items, {})
  }
}

// Album upload confirmation
const confirmAlbumUpload = async () => {
  await settingsApi.patch({ albumName: albumNameOrKey.value, albumAutoMode: false })
  const items = pendingItems.value
  showAlbumInput.value = false
  pendingItems.value = []
  pendingFileCount.value = 0
  const name = albumNameOrKey.value
  albumNameOrKey.value = ''
  await uploadManager.startUpload(items, { albumName: name })
}

const cancelAlbumUpload = () => {
  showAlbumInput.value = false
  pendingItems.value = []
  pendingFileCount.value = 0
  albumNameOrKey.value = ''
}

// Handle album error event (dispatched by UploadManager)
const albumErrorHandler = (e: Event) => {
  const event = e as CustomEvent<{ AlbumName: string; Error: string }>
  const { AlbumName, Error } = event.detail
  if (Error.includes('404')) {
    toast.error('Album not found', {
      description: `The album key "${AlbumName}" does not exist or is invalid.`,
    })
  } else {
    toast.error('Failed to create album', {
      description: `Album "${AlbumName}": ${Error}`,
    })
  }
}

const uploadErrorHandler = (e: Event) => {
  const event = e as CustomEvent<{ FileName: string; Message: string }>
  const { FileName, Message } = event.detail
  const errorMessage = Message.replace(/^Error:\s*/, '')
  toast.error(FileName ? `Upload failed: ${FileName}` : 'Upload failed', {
    description: errorMessage,
    duration: 10000,
    important: true,
  })
}

onMounted(() => {
  document.addEventListener('dragenter', onDragEnter)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('dragover', onDragOver)
  window.addEventListener('albumError', albumErrorHandler)
  window.addEventListener('uploadError', uploadErrorHandler)
})

onUnmounted(() => {
  document.removeEventListener('dragenter', onDragEnter)
  document.removeEventListener('dragleave', onDragLeave)
  document.removeEventListener('dragover', onDragOver)
  window.removeEventListener('albumError', albumErrorHandler)
  window.removeEventListener('uploadError', uploadErrorHandler)
  if (dragLeaveTimeout) {
    clearTimeout(dragLeaveTimeout)
  }
})
</script>

<template>
  <main class="w-screen h-screen flex flex-col items-center">
    <!-- Drop zones shown when dragging files -->
    <div
      v-if="!uploadState.isUploading && isDraggingFiles && options.length > 0"
      class="w-screen h-screen flex flex-col gap-3 p-6"
    >
      <div
        class="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-muted-foreground/50 rounded-xl transition-all duration-200 drop-zone"
        @dragover.prevent
        @drop="handleDropZone($event, 'regular')"
      >
        <h2 class="text-xl font-semibold select-none text-muted-foreground">
          Upload Only
        </h2>
        <p class="text-sm text-muted-foreground/70 mt-2 select-none text-center px-4">
          Upload files without adding to any album
        </p>
      </div>
      <div
        class="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-muted-foreground/50 rounded-xl transition-all duration-200 drop-zone"
        @dragover.prevent
        @drop="handleDropZone($event, 'album')"
      >
        <h2 class="text-xl font-semibold select-none text-muted-foreground">
          Upload to Album
        </h2>
        <p class="text-sm text-muted-foreground/70 mt-2 select-none text-center px-4">
          Upload and add to a specific album (you'll enter the name)
        </p>
      </div>
      <div
        class="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-muted-foreground/50 rounded-xl transition-all duration-200 drop-zone"
        @dragover.prevent
        @drop="handleDropZone($event, 'auto-album')"
      >
        <h2 class="text-xl font-semibold select-none text-muted-foreground">
          Auto Album
        </h2>
        <p class="text-sm text-muted-foreground/70 mt-2 select-none text-center px-4">
          Upload and create albums automatically based on dropped folder names
        </p>
      </div>
    </div>

    <!-- Normal UI (not dragging) -->
    <div
      v-else-if="!uploadState.isUploading"
      class="w-screen h-screen flex flex-col items-center gap-4 max-w-md px-6 pt-30"
    >
      <template v-if="options.length === 0">
        <div class="flex max-w-xs flex-col items-center gap-4 text-center">
          <div class="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserPlus class="size-5" />
          </div>
          <div class="flex flex-col gap-1">
            <h1 class="text-xl font-semibold select-none">
              Connect Google Photos
            </h1>
            <p class="text-sm text-muted-foreground select-none">
              Add an account before uploading photos and videos.
            </p>
          </div>
          <Button
            class="cursor-pointer select-none"
            @click="openAccountSetup"
          >
            Add Google account
          </Button>
        </div>
      </template>

      <template v-else>
        <!-- Show album input screen when files dropped on album zone -->
        <template v-if="showAlbumInput">
          <div class="flex flex-col items-center justify-center gap-6 p-8">
            <h1 class="text-xl font-semibold select-none">
              Upload to Album
            </h1>
            <p class="text-muted-foreground select-none">
              {{ pendingFileCount }} file(s) ready to upload
            </p>

            <div class="flex flex-col gap-2 w-full max-w-xs">
              <Label
                for="album-input"
                class="text-muted-foreground text-sm"
              >Album name or key</Label>
              <Input
                id="album-input"
                v-model="albumNameOrKey"
                placeholder="Album name or AF1Qip... key"
                autofocus
              />
            </div>

            <div class="flex gap-4">
              <Button
                variant="outline"
                class="cursor-pointer select-none"
                @click="cancelAlbumUpload"
              >
                Cancel
              </Button>
              <Button
                class="cursor-pointer select-none"
                :disabled="!albumNameOrKey.trim()"
                @click="confirmAlbumUpload"
              >
                Upload
              </Button>
            </div>
          </div>
        </template>

        <!-- Normal UI when not dragging -->
        <template v-else>
          <h1 class="text-xl font-semibold select-none">
            Drop files to upload
          </h1>
          <GoogleAccountSelect
            v-model="selectedOption"
            :options="options"
            :removing-account="removingAccount"
            :exporting-account="exportingAccount"
            @item-removed="removeCredentials"
            @item-exported="exportCredential"
            @add="openAccountSetup"
          />
          <div
            v-if="tokenBindingEmail"
            class="w-full max-w-xs border rounded-lg p-3 flex flex-col gap-3"
          >
            <p class="text-sm text-muted-foreground">
              This credential requires a token-binding key from the rooted Android device it was captured from.
            </p>
            <Button
              class="cursor-not-allowed select-none opacity-50"
              disabled
            >
              Not supported yet (upcoming)
            </Button>
          </div>

          <Sheet>
            <SheetTrigger>
              <Button
                variant="outline"
                class="cursor-pointer select-none"
              >
                Settings
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom">
              <TooltipProvider disable-hoverable-content>
                <SettingsPanel />
              </TooltipProvider>
            </SheetContent>
          </Sheet>

          <div
            v-if="uploadState.uploadedFiles > 0 || uploadState.results.fail.length > 0"
            class="flex flex-col items-center gap-2 border rounded-lg p-5 mt-5"
          >
            <h2 class="text-l font-semibold select-none ">
              Upload Results
            </h2>
            <Label class="text-muted-foreground">Successful: {{ uploadState.results.success.length }}</Label>
            <Label class="text-muted-foreground">Failed: {{ uploadState.results.fail.length }}</Label>
            <Label class="text-muted-foreground">Skipped: {{ uploadState.results.skipped.length }}</Label>
            <Label class="text-muted-foreground">Warnings: {{ uploadState.results.warnings.length }}</Label>
            <Button
              variant="outline"
              class="cursor-pointer select-none min-w-[125px]"
              @click="handleCopyClick"
            >
              {{ copyButtonText }}
            </Button>
          </div>
        </template>
      </template>
    </div>
    <div
      v-if="uploadState.isUploading"
      class="w-full h-full"
    >
      <Upload />
    </div>
    <GoogleAuthSetup
      v-model:open="isAccountSetupOpen"
      @account-added="refreshCredentials"
    />
    <Toaster
      position="bottom-center"
      rich-colors
      expand
      :visible-toasts="4"
    />
  </main>
</template>
