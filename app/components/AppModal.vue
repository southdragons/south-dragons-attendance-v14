<script setup lang="ts">
import { X } from 'lucide-vue-next'
// dismissible=false: Esc, the backdrop and the × button do nothing; the content must offer its own way out.
const props = withDefaults(defineProps<{ open: boolean; title: string; busy?: boolean; error?: string; dismissible?: boolean }>(), { dismissible: true })
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const titleId = useId()
function close() { if (!props.busy && props.dismissible) emit('close') }
// Browsers may close a <dialog> on a repeated Esc even when `cancel` is prevented.
// Keep the screen in sync: dismissible dialogs report the close, others reopen.
function onNativeClose() {
  if (!props.open) return
  if (props.dismissible && !props.busy) emit('close')
  else dialog.value?.showModal()
}
watch(() => props.open, async (open) => {
  await nextTick()
  if (open && !dialog.value?.open) dialog.value?.showModal()
  else if (!open && dialog.value?.open) dialog.value?.close()
}, { immediate: true })
</script>
<template>
  <dialog ref="dialog" class="modal modal-bottom sm:modal-middle" :aria-labelledby="titleId" :aria-busy="busy" @cancel.prevent="close" @close="onNativeClose" @click="($event.target === dialog) && close()">
    <div class="modal-box">
      <div class="modal-heading"><h2 :id="titleId">{{ title }}</h2><button v-if="dismissible" class="btn btn-ghost btn-circle" :disabled="busy" aria-label="閉じる" @click="close"><X :size="20" /></button></div>
      <fieldset :disabled="busy" class="min-w-0"><slot /></fieldset>
      <p v-if="busy" class="save-hint" role="status">処理しています…</p>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </div>
  </dialog>
</template>
