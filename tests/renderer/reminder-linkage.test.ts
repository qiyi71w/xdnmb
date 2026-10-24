import { afterEach, describe, expect, it } from 'vitest'
import type { XidaoApi } from '../../src/shared/api'
import { applyReminderChoice, linkageText } from '../../src/renderer/src/features/reminders/ReminderLinkage'

const ids = (count: number) => Array.from({ length: count }, (_, index) => String(70000 + index))
const host = globalThis as { window?: { xidao: Pick<XidaoApi, 'reminders'> } }

function withClose(close: (threadIds: string[]) => Promise<{ ok: true; closed: string[] } | { ok: false; reason: 'storage' }>) {
  const calls: string[][] = []
  host.window = { xidao: { reminders: { closeForThreads: async ({ threadIds }: { threadIds: string[] }) => {
    if (threadIds.length > 500) throw new Error('invalid request') // the main-process IPC bound
    calls.push(threadIds)
    return close(threadIds)
  } } as unknown as XidaoApi['reminders'] } }
  return calls
}

afterEach(() => { delete host.window })

describe('closing reminders for a confirmed sync deletion', () => {
  it('closes every affected thread when more than 500 threads are involved', async () => {
    const calls = withClose(async (threadIds) => ({ ok: true, closed: threadIds }))
    const linkage = await applyReminderChoice({ threadIds: ids(501), choice: 'close', result: { status: 'pending' } }, 'sync-delete')
    expect(calls.map((batch) => batch.length)).toEqual([500, 1])
    expect(linkage.result).toEqual({ status: 'closed', closed: ids(501) })
    expect(linkageText(linkage)).toEqual({ text: '本地提醒：已关闭 501 个串的提醒', warn: false })
  })

  it('reports a partial local close truthfully when one batch fails', async () => {
    withClose(async (threadIds) => threadIds.length === 500 ? { ok: true, closed: threadIds } : { ok: false, reason: 'storage' })
    const linkage = await applyReminderChoice({ threadIds: ids(501), choice: 'close', result: { status: 'pending' } }, 'sync-delete')
    expect(linkage.result).toMatchObject({ status: 'failed', failedCount: 1 })
    const text = linkageText(linkage)
    expect(text.warn).toBe(true)
    expect(text.text).toContain('部分关闭失败')
    expect(text.text).toContain('已关闭 500 个串')
  })
})
