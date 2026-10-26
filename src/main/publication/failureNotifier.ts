import { targetText } from '../../shared/drafts'
import { sendFailureNotice, sendFailureTitle, type PublicationAttempt, type SendFailureNotice } from '../../shared/publication'

interface SystemNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
}

export interface FailureNotifier {
  /** A send's result was recorded. Only an explicit failure whose draft was saved is notified. */
  recorded(attempt: PublicationAttempt): Promise<void>
  /** The window was shown or focused: failures whose system notification did not show appear in the app now. */
  windowShown(): void
}

/**
 * Notifies explicit send failures: an in-app notice while the window is in front (visible and
 * focused), else a system notification whose click opens the draft. A system notification that is
 * unsupported or fails to show leaves an in-app notice for the next time the window is shown.
 * Electron and the window are injected so focus, unsupported systems and failures are observable.
 */
export function createFailureNotifier(deps: {
  /** The window is visible, not minimized and focused. */
  foreground(): boolean
  /**
   * Hands the notice to the window's renderer; `false` when there is no window to take it. `missed`:
   * owed for a system notification that did not show (else the window was in front at the failure).
   */
  showInApp(notice: SendFailureNotice, missed: boolean): boolean
  isSupported(): boolean
  create(message: { title: string; body: string }): SystemNotification
  forumName(forumId: string): Promise<string | null>
  /** Shows the window and asks it to open the draft. */
  openDraft(notice: SendFailureNotice): Promise<void>
}): FailureNotifier {
  // Held until closed: a collected notification would lose its click handler.
  const live = new Set<SystemNotification>()
  /** In-app notices owed for missed system notifications, by attempt. */
  const missed = new Map<string, SendFailureNotice>()

  const miss = (notice: SendFailureNotice) => {
    if (deps.foreground() && deps.showInApp(notice, true)) return
    missed.set(notice.attemptId, notice)
  }

  async function system(notice: SendFailureNotice): Promise<boolean> {
    if (!deps.isSupported()) return false
    let forumName: string | null = null
    if (notice.target.kind === 'thread') forumName = await deps.forumName(notice.target.forumId).catch(() => null)
    // Reason and target only: never the content or a cookie.
    const notification = deps.create({
      title: sendFailureTitle(notice.problem),
      body: `${targetText(notice.target, () => forumName)}，内容已存为草稿`
    })
    notification.on('failed', () => {
      live.delete(notification)
      miss(notice)
    })
    notification.on('click', () => {
      live.delete(notification)
      void deps.openDraft(notice).catch(() => console.error('[publication] failure notification reveal failed'))
    })
    notification.on('close', () => { live.delete(notification) })
    live.add(notification)
    try {
      notification.show()
    } catch {
      live.delete(notification)
      return false
    }
    return true
  }

  return {
    async recorded(attempt) {
      const notice = sendFailureNotice(attempt)
      if (notice === null) return
      if (deps.foreground() && deps.showInApp(notice, false)) return
      let shown = false
      try {
        shown = await system(notice)
      } catch {
        shown = false
      }
      if (!shown) miss(notice)
    },
    windowShown() {
      for (const [attemptId, notice] of missed) {
        if (!deps.showInApp(notice, true)) return
        missed.delete(attemptId)
      }
    }
  }
}
