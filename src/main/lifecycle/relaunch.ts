/*
 * Restarting the app. A `restart` quit relaunches the app with an argument naming the quitting
 * process. The new process waits until that process has ended before it asks for the single-instance
 * lock: an instance that cannot take the lock quits at once, and the new process must not open the
 * database (or replace its files) while the old one still has it open.
 */

const RELAUNCH_AFTER = '--xidao-relaunch-after='
/** Far beyond an ordinary exit; a process still running then is left to the lock as before. */
const WAIT_LIMIT_MS = 60_000
const POLL_MS = 100

/** Arguments for the relaunched app: the current ones, naming `pid` as the process to wait for. */
export function relaunchArguments(args: readonly string[], pid: number): string[] {
  return [...args.filter((arg) => !arg.startsWith(RELAUNCH_AFTER)), `${RELAUNCH_AFTER}${pid}`]
}

/** The process this one was relaunched after, or null for an ordinary launch. */
export function relaunchedAfter(args: readonly string[]): number | null {
  const arg = args.find((value) => value.startsWith(RELAUNCH_AFTER))
  if (arg === undefined) return null
  const text = arg.slice(RELAUNCH_AFTER.length)
  const pid = /^[1-9]\d{0,9}$/.test(text) ? Number(text) : NaN
  return Number.isSafeInteger(pid) ? pid : null
}

/** Whether a process exists; one this user may not signal still counts as running. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Takes the single-instance lock. A relaunched process first waits for the process it was relaunched
 * after to end (up to a limit). `false`: another instance holds the lock; this one should quit.
 */
export async function takeSingleInstanceLock(deps: {
  args: readonly string[]
  requestLock: () => boolean
  isRunning: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
}): Promise<boolean> {
  const previous = relaunchedAfter(deps.args)
  if (previous !== null) {
    const deadline = deps.now() + WAIT_LIMIT_MS
    while (deps.isRunning(previous) && deps.now() < deadline) await deps.sleep(POLL_MS)
  }
  return deps.requestLock()
}
