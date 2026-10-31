// The startup announcement: asked for once per run after the cold-start read, shown only while a
// startup prompt is eligible (see `promptEligible`), closed by 确认 / × / Esc for this run, or
// closed by 不再提示 once that choice is stored.

import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { Announcement } from '../../../../shared/announcements'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal, ModalHeader } from '../../components/Modal'
import { AnnouncementBody } from './AnnouncementBody'
import { automaticReducer, INITIAL_AUTOMATIC, isTextEntry } from './startupPrompt'
import './announcements.css'

interface FocusConditions {
  foreground: boolean
  typing: boolean
}

function readFocus(): FocusConditions {
  return {
    foreground: document.visibilityState === 'visible' && document.hasFocus(),
    typing: isTextEntry(document.activeElement)
  }
}

/** Whether the window is in the foreground and whether a text field has the keys, kept current. */
export function useFocusConditions(): FocusConditions {
  const [conditions, setConditions] = useState(readFocus)
  useEffect(() => {
    let timer = 0
    const update = () => {
      const next = readFocus()
      setConditions((previous) => (previous.foreground === next.foreground && previous.typing === next.typing ? previous : next))
    }
    // Focus leaving an element: where it lands is known only after the event.
    const afterLeave = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(update)
    }
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', afterLeave)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', afterLeave)
    }
  }, [])
  return conditions
}

/**
 * This run's automatic announcement. `eligible`: a startup prompt may show now; `stillEligible`
 * checks the same live right before a held grant is shown (a grant that arrives while the user
 * started editing or opened a dialog waits; nothing of theirs is closed, changed or unfocused).
 * Reading the state never fetches: it waits for the one cold-start read. `drop` ends a shown
 * announcement without storing anything (a quit closes competing dialogs).
 */
export function useAutomaticAnnouncement(eligible: boolean, stillEligible: () => boolean) {
  const [state, dispatch] = useReducer(automaticReducer, INITIAL_AUTOMATIC)

  useEffect(() => {
    let alive = true
    window.xidao.announcements.getState().then(
      (value) => {
        if (alive) dispatch({ type: 'read', state: value })
      },
      () => {
        if (alive) dispatch({ type: 'read', state: null })
      }
    )
    return () => {
      alive = false
    }
  }, [])

  // Each new eligible moment may ask again (the window came back, a dialog closed).
  const wasEligible = useRef(eligible)
  useEffect(() => {
    if (eligible && !wasEligible.current) dispatch({ type: 'eligible' })
    wasEligible.current = eligible
  }, [eligible])

  // One ask at a time: a grant is spent by the main process, so its answer must never be lost to
  // a second ask racing it.
  const asking = useRef(false)
  const armed = state.phase === 'waiting' && state.armed
  useEffect(() => {
    if (!armed || !eligible || asking.current) return
    asking.current = true
    dispatch({ type: 'take' })
    window.xidao.announcements
      .takeAutomatic()
      .catch(() => null)
      .then((announcement) => {
        asking.current = false
        dispatch({ type: 'taken', announcement })
      })
  }, [armed, eligible])

  const check = useRef(stillEligible)
  useLayoutEffect(() => {
    check.current = stillEligible
  })
  const held = state.phase === 'held'
  useEffect(() => {
    if (held && eligible && check.current()) dispatch({ type: 'show' })
  }, [held, eligible])

  const close = useCallback(() => dispatch({ type: 'close' }), [])
  return { announcement: state.phase === 'shown' ? state.announcement : null, close }
}

/**
 * Focus starts on 确认. 不再提示 stores this announcement's identity first and closes only once
 * that succeeded; a failure stays visible and 确认 still closes for this run. While storing, every
 * close and repeated press is ignored. Focus returns where it was, else `fallbackFocus`.
 */
export function AnnouncementDialog({
  announcement,
  onClose,
  fallbackFocus
}: {
  announcement: Announcement
  onClose: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const failureId = useId()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const savingRef = useRef(false)
  const alive = useRef(true)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  useLayoutEffect(() => {
    alive.current = true
    confirmRef.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])

  const confirm = () => {
    if (!savingRef.current) onClose()
  }

  const suppress = () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setFailed(false)
    window.xidao.announcements
      .suppress({ date: announcement.date, content: announcement.content })
      .then(
        (result) => result.saved,
        () => false
      )
      .then((saved) => {
        savingRef.current = false
        if (!alive.current) return
        setSaving(false)
        if (saved) closeRef.current()
        else setFailed(true)
      })
  }

  return (
    <Modal className="announcement-dialog" labelledBy={titleId} onClose={confirm} fallbackFocus={fallbackFocus}>
      <ModalHeader title="X 岛公告" titleId={titleId} closeLabel="关闭公告" onClose={confirm} closeDisabled={saving} />
      <div className="modal-body announcement-body">
        <AnnouncementBody nodes={announcement.nodes} labelledBy={titleId} onOpening={confirm} />
      </div>
      <div className="modal-actions announcement-actions">
        {failed && (
          <p className="notice-inline is-warning announcement-failure" id={failureId} role="alert">
            <Icon name="alert" size={14} />
            <span>
              没能保存“不再提示”，下次启动仍会提示这条公告
              <KaomojiDecor state="failure" />
            </span>
          </p>
        )}
        <button
          type="button"
          className="btn"
          aria-disabled={saving || undefined}
          aria-busy={saving || undefined}
          aria-describedby={failed ? failureId : undefined}
          onClick={suppress}
        >
          {saving && <Spinner />}
          不再提示
        </button>
        <button ref={confirmRef} type="button" className="btn btn-primary" aria-disabled={saving || undefined} onClick={confirm}>
          确认
        </button>
      </div>
    </Modal>
  )
}
