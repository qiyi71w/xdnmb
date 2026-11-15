import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AutoQuoteTag } from '../../src/renderer/src/features/reminders/ReminderPane'
import type { ReminderKind, ReminderRule, ReminderRuleSource, ReminderThreadRow } from '../../src/shared/reminders'

const off = (kind: ReminderKind): ReminderRule => ({ kind, enabled: false, closedBy: null, source: null, baseline: null })
const on = (kind: ReminderKind, source: ReminderRuleSource): ReminderRule => ({ kind, enabled: true, closedBy: null, source, baseline: 'ready' })

function rules(quote: ReminderRule, all: ReminderRule = off('all')): ReminderThreadRow['rules'] {
  return { all, po: off('po'), quote }
}

const tag = (row: ReminderThreadRow['rules']) => renderToStaticMarkup(createElement(AutoQuoteTag, { rules: row }))

describe('提醒 row: 自动 tag', () => {
  it('shows 自动 named for screen readers when the app enabled 引用我', () => {
    expect(tag(rules(on('quote', 'auto')))).toBe(
      '<span class="tag reminder-auto"><span aria-hidden="true">自动</span><span class="visually-hidden">引用我的发言提醒为自动开启</span></span>'
    )
    // Another kind the user enabled on the same thread does not hide it.
    expect(tag(rules(on('quote', 'auto'), on('all', 'user')))).toContain('引用我的发言提醒为自动开启')
  })

  it('is absent for a 引用我 the user enabled, and once the rule is off', () => {
    expect(tag(rules(on('quote', 'user')))).toBe('')
    expect(tag(rules({ ...off('quote'), closedBy: 'auto' }, on('all', 'user')))).toBe('')
    expect(tag(rules(off('quote'), on('all', 'user')))).toBe('')
  })
})
