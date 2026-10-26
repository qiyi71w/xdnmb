import type { ReminderNotifier } from './contract'

interface SystemNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
}

/** Electron is injected so unsupported systems and failed attempts are observable. */
export function createReminderNotifier(deps: {
  isSupported(): boolean
  create(message: { title: string; body: string }): SystemNotification
  openList(): Promise<void>
}): ReminderNotifier {
  // Held until closed: a collected notification would lose its click handler.
  const live = new Set<SystemNotification>()
  return {
    show(message) {
      if (!deps.isSupported()) return false
      const notification = deps.create(message)
      notification.on('failed', () => { live.delete(notification) })
      notification.on('click', () => { void deps.openList().catch(() => console.error('[reminders] notification reveal failed')) })
      notification.on('close', () => { live.delete(notification) })
      live.add(notification)
      try {
        notification.show()
      } catch (error) {
        live.delete(notification)
        throw error
      }
      return true
    }
  }
}
