import { describe, expect, it } from 'vitest'
import { relaunchArguments, relaunchedAfter, takeSingleInstanceLock } from '../src/main/lifecycle/relaunch'

/** A process that ends after `polls` checks, a lock that records when it was asked for. */
function harness(polls: number, args: string[]) {
  const events: string[] = []
  let clock = 0
  let remaining = polls
  const lock = takeSingleInstanceLock({
    args,
    requestLock: () => {
      events.push(`lock at ${clock}`)
      return true
    },
    isRunning: (pid) => {
      events.push(`check ${pid}`)
      return remaining-- > 0
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock
  })
  return { lock, events }
}

describe('relaunch ordering', () => {
  it('names the quitting process once, keeping the other arguments', () => {
    const args = relaunchArguments(['.', '--flag', '--xidao-relaunch-after=11'], 22)
    expect(args).toEqual(['.', '--flag', '--xidao-relaunch-after=22'])
    expect(relaunchedAfter(args)).toBe(22)
    expect(relaunchedAfter(['.'])).toBeNull()
    expect(relaunchedAfter(['--xidao-relaunch-after=x1'])).toBeNull()
  })

  it('takes the lock only after the previous process has ended', async () => {
    const { lock, events } = harness(3, ['.', '--xidao-relaunch-after=42'])
    expect(await lock).toBe(true)
    expect(events).toEqual(['check 42', 'check 42', 'check 42', 'check 42', 'lock at 300'])
  })

  it('takes the lock at once on an ordinary launch', async () => {
    const { lock, events } = harness(3, ['.'])
    expect(await lock).toBe(true)
    expect(events).toEqual(['lock at 0'])
  })

  it('stops waiting at the limit and leaves the decision to the lock', async () => {
    const { lock, events } = harness(Number.POSITIVE_INFINITY, ['--xidao-relaunch-after=42'])
    expect(await lock).toBe(true)
    expect(events.at(-1)).toBe('lock at 60000')
  })
})
