import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { useIssuedCode } from '../app/composables/useIssuedCode'

it('shows a newly issued code with copy and confirmation reset', () => {
  const issued = useIssuedCode(() => undefined)
  expect(issued.open.value).toBe(false)
  issued.show('SD-ABCD-EFGH')
  expect(issued.open.value).toBe(true)
  expect(issued.code.value).toBe('SD-ABCD-EFGH')
  expect(issued.acknowledged.value).toBe(false)
  expect(issued.canClose.value).toBe(false)
})
it('copies the code to the clipboard', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  const issued = useIssuedCode(() => ({ writeText }))
  issued.show('SD-ABCD-EFGH'); await issued.copy()
  expect(writeText).toHaveBeenCalledWith('SD-ABCD-EFGH')
  expect(issued.copied.value).toBe(true)
  expect(issued.copyError.value).toBe('')
})
it('explains a failed copy and keeps the code visible', async () => {
  for (const clipboard of [() => undefined, () => ({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })]) {
    const issued = useIssuedCode(clipboard)
    issued.show('SD-ABCD-EFGH'); await issued.copy()
    expect(issued.copied.value).toBe(false)
    expect(issued.copyError.value).toContain('長押し')
    expect(issued.open.value).toBe(true)
  }
})
it('refuses to close until the admin confirms the code was saved, then forgets it', () => {
  const issued = useIssuedCode(() => undefined)
  issued.show('SD-ABCD-EFGH')
  expect(issued.close()).toBe(false)
  expect(issued.open.value).toBe(true)
  issued.acknowledged.value = true
  expect(issued.canClose.value).toBe(true)
  expect(issued.close()).toBe(true)
  expect(issued.open.value).toBe(false)
  expect(issued.code.value).toBe('')
  issued.show('SD-2345-6789') // a later issue starts unconfirmed again
  expect(issued.canClose.value).toBe(false)
})
it('the issued-code dialog cannot be dismissed by Esc, backdrop or the × button', () => {
  const modal = readFileSync('app/components/AppModal.vue', 'utf8')
  expect(modal).toContain("function close() { if (!props.busy && props.dismissible) emit('close') }")
  expect(modal).toContain('@cancel.prevent="close"') // Esc
  expect(modal).toContain("@click=\"($event.target === dialog) && close()\"") // backdrop
  expect(modal).toContain('<button v-if="dismissible"') // × hidden
  expect(modal).toContain('else dialog.value?.showModal()') // forced native close reopens
  const app = readFileSync('app/app.vue', 'utf8')
  const dialog = app.slice(app.indexOf('title="新しいチームコード"') - 200, app.indexOf('閉じる（再表示はできません）') + 40)
  expect(dialog).toContain(':dismissible="false"')
  expect(dialog).toContain('v-model="codeAcknowledged"')
  expect(dialog).toContain(':disabled="!issuedCanClose"')
})
