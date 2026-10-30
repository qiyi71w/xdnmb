import { describe, expect, it } from 'vitest'
import { visits } from '../../src/renderer/src/lib/useClearOnLeave'

describe('page visits (success results cleared on leaving a page)', () => {
  it('keeps an operation current while its page has not been left', () => {
    const page = visits()
    const current = page.begin()
    expect(current()).toBe(true)
  })

  it('makes an operation begun before a leave stale, even after the page is shown again', () => {
    const page = visits()
    const saving = page.begin()
    page.leave()
    // Finishing while hidden, or after the return: neither may show its success.
    expect(saving()).toBe(false)
    const again = page.begin()
    expect(saving()).toBe(false)
    expect(again()).toBe(true)
  })

  it('lets an operation begun on the new visit show its success until the next leave', () => {
    const page = visits()
    page.leave()
    const current = page.begin()
    expect(current()).toBe(true)
    page.leave()
    expect(current()).toBe(false)
  })
})
