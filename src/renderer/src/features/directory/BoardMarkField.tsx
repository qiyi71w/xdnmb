// A favorite board's own rail mark, saved as it is typed. Its placeholder is the automatic mark,
// which an empty field returns to. Typing keeps at most two characters without spaces; while an
// input method composes, the text is left alone and cut only when composition ends.

import { useRef, useState, type KeyboardEvent } from 'react'
import { boardMarkFrom } from '../../../../shared/settings'
import { useSettings } from '../../lib/settingsContext'
import { useNavActions } from './navStore'

export function BoardMarkField({
  boardKey,
  label,
  auto,
  id,
  describedBy,
  onEnter
}: {
  boardKey: string
  label: string
  /** The mark shown when the field is empty. */
  auto: string
  id?: string
  describedBy?: string
  /** Enter outside composition (the rail's editor closes on it). */
  onEnter?: () => void
}) {
  const actions = useNavActions()
  const saved = useSettings().settings.boardMarks[boardKey] ?? ''
  const [value, setValue] = useState(saved)
  // Changed elsewhere (the other editor of the same mark): show the saved one.
  const [shown, setShown] = useState(saved)
  if (shown !== saved) {
    setShown(saved)
    setValue(saved)
  }
  const composing = useRef(false)

  const commit = (text: string) => {
    const next = boardMarkFrom(text)
    setValue(next)
    if (next !== saved) actions.setMark(boardKey, next === '' ? null : next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    onEnter?.()
  }

  return (
    <input
      id={id}
      type="text"
      className="text-input shell-mark-input"
      value={value}
      placeholder={auto}
      aria-label={`${label}的缩写`}
      aria-describedby={describedBy}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => {
        if (composing.current) setValue(event.target.value)
        else commit(event.target.value)
      }}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={(event) => {
        composing.current = false
        commit(event.currentTarget.value)
      }}
      onKeyDown={onKeyDown}
    />
  )
}
