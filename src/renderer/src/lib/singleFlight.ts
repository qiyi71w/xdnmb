/**
 * One action at a time, decided synchronously. A busy flag in React state lands a render later, so
 * two presses (a double click, Enter twice, Enter and a click) can both pass a check of it; this
 * guard is taken before the first await. While an action runs, `run` refuses another (returns
 * `undefined` without calling it); the guard is released when it settles, thrown or not.
 * Keep one per view in a ref or lazy state: `useState(singleFlight)`.
 */
export interface SingleFlight {
  readonly running: boolean
  run<T>(action: () => Promise<T>): Promise<T | undefined>
}

export function singleFlight(): SingleFlight {
  let running = false
  return {
    get running() {
      return running
    },
    async run<T>(action: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined
      running = true
      try {
        return await action()
      } finally {
        running = false
      }
    }
  }
}
