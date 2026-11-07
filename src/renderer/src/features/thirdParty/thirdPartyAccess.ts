// The renderer's view of the third-party permissions and the one place that asks for them. The
// main process decides and enforces everything; this keeps its state current (re-read on every
// change it announces) and runs the questions: the first-run disclosure and, later, a question
// for one service when the user starts something that needs it.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ThirdPartyState } from '../../../../shared/third-party'
import { disclosureReducer, disclosureSettled, INITIAL_DISCLOSURE, serviceAllowed } from './thirdPartyState'

/** Services the user can be asked for later. Statistics are never asked for again. */
export type AskedService = 'updates' | 'search'

export interface ThirdPartyAccess {
  /** The latest state read from main; `null` until read or when unreadable. */
  state: ThirdPartyState | null
  /**
   * The startup restore is done and the first-run disclosure answered: a view the user enters
   * from now on was entered on purpose and may ask for what it needs. Views restored at startup
   * mount before this and ask nothing until the user acts.
   */
  entryReady: boolean
  /**
   * Whether `service` may be used now, else asks for it (one question at a time; a request while
   * one is open, or before the first-run disclosure was answered, gets `false`). Resolves `true`
   * only once the service is on and stored. `signal`: the asking view went away; the question
   * closes and resolves `false`. The caller continues its own action once, if still current.
   */
  ask(service: AskedService, signal?: AbortSignal): Promise<boolean>
  /** A state main returned for a change made elsewhere (设置). */
  apply(state: ThirdPartyState): void
}

const NONE: ThirdPartyAccess = { state: null, entryReady: false, ask: async () => false, apply: () => undefined }

export const ThirdPartyContext = createContext<ThirdPartyAccess>(NONE)

export function useThirdParty(): ThirdPartyAccess {
  return useContext(ThirdPartyContext)
}

/**
 * A user action that needs `service`: `run(action)` performs it without asking while the service is on,
 * else asks and performs it once only if granted and `stillCurrent()` (the view is still on
 * screen). While a question is open further presses are ignored; leaving (unmount or `cancel`)
 * closes the question and drops the action.
 */
export function useGatedAction(service: AskedService, stillCurrent?: () => boolean) {
  const { state, ask } = useThirdParty()
  const allowed = state !== null && serviceAllowed(state, service)
  const controller = useRef<AbortController | null>(null)
  const [asking, setAsking] = useState(false)
  const current = useRef(stillCurrent)
  useLayoutEffect(() => {
    current.current = stillCurrent
  })
  useEffect(() => () => controller.current?.abort(), [])

  const run = useCallback(
    (action: () => void) => {
      if (controller.current !== null) return
      // Unreadable state: nothing to ask with; main enforces and the action reports its refusal.
      if (allowed || state === null) {
        action()
        return
      }
      const own = new AbortController()
      controller.current = own
      setAsking(true)
      void ask(service, own.signal).then((ok) => {
        if (controller.current === own) {
          controller.current = null
          setAsking(false)
        }
        if (ok && !own.signal.aborted && (current.current?.() ?? true)) action()
      })
    },
    [ask, service, allowed, state]
  )
  const cancel = useCallback(() => controller.current?.abort(), [])
  return { allowed, asking, run, cancel }
}

/** The open question for one service. */
export interface PendingAsk {
  service: AskedService
  answer(granted: boolean, state: ThirdPartyState | null): void
}

/**
 * Owned by the app shell. `eligible` / `stillEligible`: whether the first-run disclosure may show
 * now (as for startup prompts, see `promptEligible`). `restored`: the startup restore and its
 * lifecycle check are done. Returns the access to provide, the disclosure's phase and controls,
 * the open question, and `whenRead` for the startup restore.
 */
export function useThirdPartyHost(eligible: boolean, stillEligible: () => boolean, restored: boolean) {
  const [state, setState] = useState<ThirdPartyState | null>(null)
  const [disclosure, dispatch] = useReducer(disclosureReducer, INITIAL_DISCLOSURE)
  const [first] = useState(() => Promise.withResolvers<ThirdPartyState | null>())
  /** Newer reads win: a change announced meanwhile reads again. */
  const readSeq = useRef(0)

  const read = useCallback(() => {
    const seq = (readSeq.current += 1)
    return window.xidao.thirdParty.getState().then(
      (value) => {
        if (seq === readSeq.current) setState(value)
        return value
      },
      () => null
    )
  }, [])

  useEffect(() => {
    let alive = true
    read().then((value) => {
      first.resolve(value)
      if (alive) dispatch({ type: 'read', state: value })
    })
    const off = window.xidao.thirdParty.onChanged(() => {
      void read()
    })
    return () => {
      alive = false
      off()
    }
  }, [read, first])

  const apply = useCallback((value: ThirdPartyState) => {
    readSeq.current += 1
    setState(value)
  }, [])

  // ---------- First-run disclosure ----------
  const check = useRef(stillEligible)
  useLayoutEffect(() => {
    check.current = stillEligible
  })
  const waiting = disclosure.phase === 'waiting'
  useEffect(() => {
    if (waiting && eligible && check.current()) dispatch({ type: 'show' })
  }, [waiting, eligible])

  /** Answered (stored, or everything off for this run): the main state that came with it. */
  const answered = useCallback(
    (value: ThirdPartyState | null) => {
      if (value !== null) apply(value)
      dispatch({ type: 'close' })
    },
    [apply]
  )
  const dropDisclosure = useCallback(() => dispatch({ type: 'drop' }), [])

  // ---------- Later questions ----------
  const [pending, setPending] = useState<PendingAsk | null>(null)
  const pendingRef = useRef<PendingAsk | null>(null)
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  })

  const ask = useCallback(
    (service: AskedService, signal?: AbortSignal): Promise<boolean> => {
      const current = stateRef.current
      if (current !== null && serviceAllowed(current, service)) return Promise.resolve(true)
      // One question at a time; never before the first-run disclosure was answered.
      if (pendingRef.current !== null || current === null || !current.acknowledged || signal?.aborted) return Promise.resolve(false)
      const { promise, resolve } = Promise.withResolvers<boolean>()
      const settle = (value: boolean) => {
        if (pendingRef.current !== item) return
        pendingRef.current = null
        signal?.removeEventListener('abort', abort)
        setPending(null)
        resolve(value)
      }
      const abort = () => settle(false)
      const item: PendingAsk = {
        service,
        answer: (granted, value) => {
          if (value !== null) apply(value)
          settle(granted)
        }
      }
      pendingRef.current = item
      signal?.addEventListener('abort', abort)
      setPending(item)
      return promise
    },
    [apply]
  )

  /** A quit closes competing dialogs: the open question counts as declined. */
  const dropAsk = useCallback(() => pendingRef.current?.answer(false, null), [])

  const entryReady = restored && disclosureSettled(disclosure)
  const access = useMemo<ThirdPartyAccess>(() => ({ state, entryReady, ask, apply }), [state, entryReady, ask, apply])
  const whenRead = useCallback(() => first.promise, [first])

  return {
    access,
    whenRead,
    disclosure: {
      shown: disclosure.phase === 'shown',
      settled: disclosureSettled(disclosure),
      initial: state,
      answered,
      drop: dropDisclosure
    },
    pending,
    dropAsk
  }
}
