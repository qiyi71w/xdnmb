import { afterEach, expect, it, vi } from 'vitest'
import { retryBlocks, setBlocked } from '../../src/renderer/src/features/thread/useBlocks'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('retries a failed block write with the same target and state, then applies it', async () => {
  const set = vi.fn().mockResolvedValueOnce({ saved: false }).mockResolvedValue({ saved: true })
  const list = vi.fn().mockResolvedValue([])
  vi.stubGlobal('window', { xidao: { blocks: { list, set } } })
  await setBlocked('cookie', 'Reply1', true)
  await retryBlocks()
  expect(set.mock.calls).toEqual([[{ kind: 'cookie', value: 'Reply1', blocked: true }], [{ kind: 'cookie', value: 'Reply1', blocked: true }]])
  expect(list).not.toHaveBeenCalled()
})

it('reads the list again when the failure was a read', async () => {
  const set = vi.fn()
  const list = vi.fn().mockRejectedValueOnce(new Error('read')).mockResolvedValue([{ kind: 'post', value: '1', createdAt: '2026-10-25T00:00:00.000Z' }])
  vi.stubGlobal('window', { xidao: { blocks: { list, set } } })
  await retryBlocks()
  await retryBlocks()
  expect(list).toHaveBeenCalledTimes(2)
  expect(set).not.toHaveBeenCalled()
})
