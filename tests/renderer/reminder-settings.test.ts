import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReminderSection } from '../../src/renderer/src/app/settingsSections'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'

/** The element in `node` whose props name `labelledBy`, searched through children. */
function control(node: ReactNode, labelledBy: string): { onToggle: () => void } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = control(child, labelledBy)
      if (found !== null) return found
    }
    return null
  }
  if (!isValidElement<{ labelledBy?: string; onToggle?: () => void; children?: ReactNode }>(node)) return null
  if (node.props.labelledBy === labelledBy && node.props.onToggle) return { onToggle: node.props.onToggle }
  return control(node.props.children, labelledBy)
}

describe('提醒 settings: 发言后提醒引用我', () => {
  it('is a switch named by its label and described by its line, on by default', () => {
    const markup = renderToStaticMarkup(createElement(ReminderSection, { settings: DEFAULT_SETTINGS, write: () => {} }))
    expect(markup).toContain('<span class="setting-label" id="setting-reminder-auto-quote">发言后提醒引用我</span>')
    expect(markup).toContain('<span class="setting-help" id="setting-reminder-auto-quote-help">在汐岛发言的串自动开启，7 天没再发言后关闭</span>')
    expect(markup).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-labelledby="setting-reminder-auto-quote"[^>]*aria-describedby="setting-reminder-auto-quote-help"/)
    const off = renderToStaticMarkup(createElement(ReminderSection, { settings: { ...DEFAULT_SETTINGS, reminderAutoQuote: false }, write: () => {} }))
    expect(off).toMatch(/aria-checked="false"[^>]*aria-labelledby="setting-reminder-auto-quote"/)
  })

  it('toggling writes the opposite of the current choice', () => {
    for (const reminderAutoQuote of [true, false]) {
      const writes: Partial<AppSettings>[] = []
      const tree = ReminderSection({ settings: { ...DEFAULT_SETTINGS, reminderAutoQuote }, write: (patch) => { writes.push(patch) } })
      control(tree, 'setting-reminder-auto-quote')!.onToggle()
      expect(writes).toEqual([{ reminderAutoQuote: !reminderAutoQuote }])
    }
  })
})
