import { createContentRegistry, type ReaderHandle } from '../../../src/renderer/src/features/tabs/contentRegistry'
import { createReadingNavigation, navigationReducer, type NavigationAction, type NavigationIntent, type NavigationState } from '../../../src/renderer/src/features/tabs/readingNavigation'
import { currentEntry, type TabsState, type ThreadSnapshot } from '../../../src/renderer/src/features/tabs/tabsState'

/** Controlled React commit timing, with the production reducer and the consumer navigation interface. */
export function navigationHarness(tabs: TabsState, options: {
  capture?: () => ThreadSnapshot | null
  showInPlace?: ReaderHandle['showInPlace']
  beforeCommit?: (state: NavigationState) => void
  splitDefault?: boolean
} = {}) {
  let state: NavigationState = { tabs, receipts: [] }
  const queued: NavigationAction[] = []
  const registry = createContentRegistry()
  for (const tab of tabs.tabs) {
    registry.readers.set(currentEntry(tab).key, { current: {
      capture: options.capture ?? (() => null),
      showInPlace: options.showInPlace ?? (() => false),
      refresh() {}, async refreshAfterSend() {},
      shown: () => ({ threadId: '100', mode: 'all', title: null })
    } })
  }
  const dispatch = (action: NavigationAction) => { queued.push(action) }
  const driver = createReadingNavigation({ getTabs: () => state.tabs, dispatch, registry, getSplitDefault: () => options.splitDefault ?? true })
  return {
    navigation: driver.navigation, registry, dispatch,
    get tabs() { return state.tabs! },
    batch() {
      const actions = queued.splice(0)
      state = actions.reduce(navigationReducer, state)
      options.beforeCommit?.(state)
      driver.committed(state)
    },
    flush() {
      for (let count = 0; queued.length > 0; count++) {
        if (count > 30) throw new Error('Navigation did not settle')
        this.batch()
      }
    },
    replay() { driver.committed(state) },
    dispose: driver.dispose
  }
}

export function navigateTabs(tabs: TabsState, intent: NavigationIntent, snapshot: ThreadSnapshot | null = null): TabsState {
  const host = navigationHarness(tabs, { capture: () => snapshot })
  const source = host.navigation.source({ tabId: tabs.activeId })!
  void host.navigation.open(source, intent)
  host.flush()
  return host.tabs
}
