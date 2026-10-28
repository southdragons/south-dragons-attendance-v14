import { computed, ref } from 'vue'

type Clipboard = { writeText: (text: string) => Promise<void> }

// One-time display of a newly issued team code. The dialog can only be closed after the
// admin confirms they saved the code; the value is dropped as soon as it closes.
export function useIssuedCode(clipboard: () => Clipboard | undefined = () => globalThis.navigator?.clipboard) {
  const code = ref('')
  const acknowledged = ref(false)
  const copied = ref(false)
  const copyError = ref('')
  const open = computed(() => code.value !== '')
  const canClose = computed(() => acknowledged.value)
  function show(value: string) { code.value = value; acknowledged.value = false; copied.value = false; copyError.value = '' }
  async function copy() {
    try {
      const target = clipboard()
      if (!target) throw new Error('unavailable')
      await target.writeText(code.value)
      copied.value = true; copyError.value = ''
    } catch {
      copied.value = false
      copyError.value = 'コピーできませんでした。表示されたコードを長押しして選択するか、メモしてください。'
    }
  }
  // Returns false (and keeps the code on screen) until the admin has confirmed.
  function close() {
    if (!acknowledged.value) return false
    code.value = ''; acknowledged.value = false; copied.value = false; copyError.value = ''
    return true
  }
  return { code, acknowledged, copied, copyError, open, canClose, show, copy, close }
}
