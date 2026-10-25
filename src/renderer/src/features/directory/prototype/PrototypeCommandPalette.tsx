// PROTOTYPE (throwaway) variant C: Ctrl/Cmd+K command palette. Lists every feature (hidden ones
// included), 设置 and every board (hidden ones included), filtered as you type.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AppPlatform } from '../../../../../shared/api'
import { Icon, type IconName } from '../../../components/Icon'
import { Modal } from '../../../components/Modal'
import type { ListRef } from '../../tabs/tabsState'
import { featureLabel, type FeatureHost } from './PrototypeNavParts'
import { FEATURES, setPaletteOpen, type BoardGroup } from './prototypeStore'

interface Command {
  key: string
  label: string
  /** Spoken name with badges (features only). */
  spoken?: string
  hint: string
  icon: IconName
  run: () => void
}

/** Ctrl+K (⌘K on macOS) opens the palette unless `blocked()` (another dialog covers the app). */
export function usePaletteShortcut(enabled: boolean, platform: AppPlatform | null, blocked: () => boolean): void {
  useEffect(() => {
    if (!enabled || platform === null) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return
      const primary = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!primary || (event.key.toLowerCase() !== 'k' && event.code !== 'KeyK')) return
      event.preventDefault()
      if (!blocked()) setPaletteOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, platform, blocked])
}

export function PrototypeCommandPalette({
  features,
  groups,
  onSelectBoard,
  onOpenSettings
}: {
  features: FeatureHost
  /** Every board group, hidden boards included. */
  groups: BoardGroup[]
  onSelectBoard: (ref: ListRef) => void
  onOpenSettings: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)

  const commands = useMemo<Command[]>(
    () => [
      ...FEATURES.map((feature) => ({
        key: `feature:${feature.id}`,
        label: feature.label,
        spoken: featureLabel(feature.id, features),
        hint: '功能',
        icon: feature.icon,
        run: () => features.open(feature.id)
      })),
      { key: 'settings', label: '设置', hint: '设置', icon: 'settings' as const, run: onOpenSettings },
      ...groups.flatMap((group) =>
        group.boards.map((board) => ({
          key: board.key,
          label: board.label,
          hint: group.title,
          icon: board.icon,
          run: () => onSelectBoard(board.ref)
        }))
      )
    ],
    [features, groups, onSelectBoard, onOpenSettings]
  )

  const needle = query.trim().toLowerCase()
  const matches = needle === '' ? commands : commands.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(needle))
  const current = Math.min(active, Math.max(0, matches.length - 1))

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, needle])

  const choose = (command: Command | undefined) => {
    if (command === undefined) return
    setPaletteOpen(false)
    command.run()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (matches.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((current + delta + matches.length) % matches.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(matches[current])
    }
  }

  return (
    <Modal className="proto-palette" label="跳转到" onClose={() => setPaletteOpen(false)}>
      <div className="proto-palette-field">
        <Icon name="search" />
        <input
          className="proto-palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={matches.length === 0 ? undefined : `${listId}-${current}`}
          aria-autocomplete="list"
          aria-label="跳转到"
          placeholder="功能、版块或设置"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul className="proto-palette-list" role="listbox" id={listId} aria-label="结果" ref={listRef}>
        {matches.map((item, index) => (
          <li
            key={item.key}
            id={`${listId}-${index}`}
            role="option"
            aria-label={item.spoken}
            aria-selected={index === current}
            className={index === current ? 'proto-palette-item is-active' : 'proto-palette-item'}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(item)}
          >
            <Icon name={item.icon} className="proto-palette-icon" />
            <span className="proto-palette-label">
              {item.label}
            </span>
            <span className="proto-palette-hint">{item.hint}</span>
          </li>
        ))}
        {matches.length === 0 && <li className="proto-palette-empty">没有匹配项</li>}
      </ul>
    </Modal>
  )
}
