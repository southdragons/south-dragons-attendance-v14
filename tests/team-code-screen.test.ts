import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Regression (found in local UI testing): after view access was revoked, an attendance dialog that was
// already open kept showing the player and event. Every dialog with roster data must close on lock.
it('closes every dialog holding roster data when the team code becomes required', () => {
  const app = readFileSync('app/app.vue', 'utf8')
  const watcher = app.slice(app.indexOf('watch(teamCodeRequired'), app.indexOf('// --- Team code: entry screen'))
  expect(watcher).toContain('if (!required) return')
  for (const reset of ['selected.value = null', 'detail.value = null', 'registration.value = false',
    'devicePlayer.value = null', 'editingPlayer.value = null', 'eventEditor.value = false', 'confirmAction.value = null', "view.value = 'attendance'"])
    expect(watcher).toContain(reset)
  // every AppModal bound to roster state is covered by the reset above
  for (const open of [':open="registration"', ':open="!!selected"', ':open="!!detail"', ':open="eventEditor"', ':open="!!editingPlayer"', ':open="!!devicePlayer && admin"', ':open="!!confirmAction"'])
    expect(app).toContain(open)
  // The registration dialog keeps its own state and starts over every time it opens.
  const dialog = readFileSync('app/components/RegistrationDialog.vue', 'utf8')
  expect(dialog).toContain("watch(() => props.open, open => { if (open) reset() })")
})
