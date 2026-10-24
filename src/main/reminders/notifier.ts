import type { ReminderNotifier } from './contract'

interface SystemNotification {
  on(event: 'click' | 'close' | 'show' | 'failed', listener: () => void): unknown
  show(): void
}

/** Electron is injected so unsupported systems and synchronous show failures are observable. */
export function createReminderNotifier(deps: {
  isSupported(): boolean
  create(message: { title: string; body: string }): SystemNotification
  openList(): Promise<void>
}): ReminderNotifier {
  const live = new Set<SystemNotification>()
  return {
    show(message, settle) {
      if (!deps.isSupported()) return false
      const notification = deps.create(message)
      let settled = false
      const report = (state: 'shown' | 'failed') => {
        if (settled) return
        settled = true
        settle(state)
      }
      notification.on('show', () => report('shown'))
      notification.on('failed', () => { live.delete(notification); report('failed') })
      notification.on('click', () => { void deps.openList().catch(() => console.error('[reminders] notification reveal failed')) })
      notification.on('close', () => { live.delete(notification) })
      live.add(notification)
      try {
        notification.show()
      } catch (error) {
        live.delete(notification)
        settled = true
        throw error
      }
      return true
    }
  }
}
