import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { BoardDirectory } from '../../../../shared/forum'
import { SEARCH_CHANNELS, type SearchChannel } from '../../../../shared/online-search'
import { useSettings } from '../../lib/settingsContext'
import { ContentRegistryContext, useRegisterContent, type SearchPageMemory, type SearchPageSide } from '../tabs/contentRegistry'
import type { EntryInit } from '../tabs/tabsState'
import { NumberOpen } from './NumberOpen'
import { OnlineSearchPane } from './OnlineSearchPane'
import { CHANNEL_TEXT } from './onlineSearchText'
import { LocalSearchContext } from './SearchContext'
import { focusSearch, SearchBody } from './SearchSheet'
import { tabSearchOf } from './searchState'
import './search.css'
import './online-search.css'

const SIDE_TEXT: Record<SearchPageSide, string> = { local: '本机', online: '联网' }

/**
 * 搜索 page, shown by an `online-search` entry: 本机｜联网 over two separate searches, 本机 first,
 * plus 按串号打开, which belongs to neither side nor channel. 本机 is the tab's local search (the
 * shell holds it open while this page is shown); 联网 shows one channel (XDS｜nmb-search) of the
 * entry's online state, each channel with its own query, pages and requests. Both sides stay
 * mounted, so switching sides keeps each one's text, results and scroll and sends nothing; switching
 * channel sends nothing either and remembers the choice as the default of new search pages. The page
 * is no layer: Esc only cancels a running locate or lookup.
 */
export function SearchPage({
  tabId,
  entryKey,
  displayed,
  directory,
  onOpen
}: {
  tabId: number
  entryKey: number
  /** The page is on screen (its tab is active). */
  displayed: boolean
  directory: BoardDirectory | null
  /** Opens a target from this page as a new `online-search` step of its tab, or (`newTab`) in a new active tab. */
  onOpen: (entryKey: number, init: EntryInit, newTab?: boolean) => boolean
}) {
  const registry = useContext(ContentRegistryContext)
  const host = useContext(LocalSearchContext)
  const settings = useSettings()
  if (registry === null || host === null) throw new Error('SearchPage needs the content registry and the local search')
  const [memory] = useState<SearchPageMemory>(() => {
    const existing = registry.searchPageMemory.get(entryKey)
    if (existing !== undefined) return existing
    const created: SearchPageMemory = { side: 'local', localScrollTop: 0, numberDraft: '', numberFocus: false }
    registry.searchPageMemory.set(entryKey, created)
    return created
  })
  // A new page starts with the saved channel preference; afterwards the page keeps its own choice.
  const [online] = useState(() => registry.onlineSearches.entry(entryKey, settings.latest().onlineSearchChannel))
  const channel = useSyncExternalStore(online.subscribe, online.getChannel)
  const [side, setSide] = useState(memory.side)
  const [numberDraft, setNumberDraft] = useState(memory.numberDraft)
  const localScrollRef = useRef<HTMLDivElement>(null)
  const localInputRef = useRef<HTMLInputElement>(null)
  const localListRef = useRef<HTMLUListElement>(null)
  const numberInputRef = useRef<HTMLInputElement>(null)
  // Focus requests of the 本机 side: on mount (back to the chosen hit after a restore, else the
  // query), then each time 本机 is chosen. The shell's own focus requests are for the sheet.
  const [localFocus, setLocalFocus] = useState(() => ({ target: host.state.focus, seq: 0 }))
  const focusOnline = useRef(false)
  /** The channel pane about to mount replaces another by a channel switch: focus stays on the switch. */
  const channelSwitched = useRef(false)
  const tab = tabSearchOf(host.state, tabId)

  const show = (next: SearchPageSide) => {
    if (next === 'local') setLocalFocus((before) => ({ target: 'input', seq: before.seq + 1 }))
    else if (side === 'online') registry.onlineSearchPanes.get(entryKey)?.current.focusInput()
    else focusOnline.current = true
    if (next === side) return
    // A hit still being located on the side left behind would open from out of sight.
    if (side === 'local') host.commands.cancelLocate(tabId)
    memory.side = next
    setSide(next)
  }

  /**
   * Shows `next` without any request (the pane of the channel left behind unmounts, dropping its
   * running locate; its awaited search keeps landing in its own session) and saves it as the
   * default channel of new search pages.
   */
  const chooseChannel = (next: SearchChannel) => {
    if (next !== online.getChannel()) {
      channelSwitched.current = true
      online.setChannel(next)
    }
    if (settings.latest().onlineSearchChannel !== next) settings.write({ onlineSearchChannel: next })
  }

  useRegisterContent('searchPages', entryKey, { show })

  useLayoutEffect(() => {
    channelSwitched.current = false
    if (!focusOnline.current) return
    focusOnline.current = false
    registry.onlineSearchPanes.get(entryKey)?.current.focusInput()
  })

  // 本机 focus requests; while 联网 is shown the hidden 本机 side takes none, nor does a page
  // mounted out of sight (opened in a background tab).
  useLayoutEffect(() => {
    if (!displayed) return
    focusSearch({ input: localInputRef, list: localListRef }, tab, 'local', localFocus.target)
    // Only a new request moves focus, not every update of the results.
  }, [localFocus.seq])

  // Back from a target opened by 按串号打开: its box gets focus again (after the sides' own requests).
  useLayoutEffect(() => {
    if (!memory.numberFocus) return
    memory.numberFocus = false
    if (displayed) numberInputRef.current?.focus()
    // Mount only.
  }, [])

  // 本机 shown (mounted, or chosen again): back to where it was scrolled. Its search box is sticky,
  // so focusing it does not move the results.
  useLayoutEffect(() => {
    const scroller = localScrollRef.current
    if (side === 'local' && scroller !== null) scroller.scrollTop = memory.localScrollTop
  }, [side, memory])

  // A hidden scroller (inactive tab) may drop its position: put it back when shown again.
  useLayoutEffect(() => {
    const scroller = localScrollRef.current
    if (scroller === null) return
    let hidden = scroller.clientHeight === 0
    const observer = new ResizeObserver(() => {
      const shown = scroller.clientHeight > 0
      if (shown && hidden && scroller.scrollTop !== memory.localScrollTop) scroller.scrollTop = memory.localScrollTop
      hidden = !shown
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [memory])

  const onLocalScroll = () => {
    const scroller = localScrollRef.current
    if (scroller !== null && scroller.clientHeight > 0) memory.localScrollTop = scroller.scrollTop
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || side !== 'local') return
    if (host.commands.cancelLocate(tabId)) event.preventDefault()
  }

  const openNumber = (init: EntryInit, newTab: boolean): boolean => {
    // Coming back to this page (a new tab keeps this one as it is) returns to the box.
    memory.numberFocus = !newTab
    const opened = onOpen(entryKey, init, newTab)
    if (!opened) memory.numberFocus = false
    return opened
  }

  return (
    <section className="search-page" aria-label="搜索" onKeyDown={onKeyDown}>
      <div className="search-page-column">
        <div className="search-page-bar">
          <div className="search-page-switches">
            <div className="segmented" role="group" aria-label="搜索范围">
              {(['local', 'online'] as const).map((item) => (
                <button key={item} type="button" className="segmented-item" aria-pressed={side === item} onClick={() => show(item)}>
                  {SIDE_TEXT[item]}
                </button>
              ))}
            </div>
            {side === 'online' && (
              <div className="segmented search-page-channel" role="group" aria-label="联网搜索服务">
                {SEARCH_CHANNELS.map((item) => (
                  <button key={item} type="button" className="segmented-item" aria-pressed={channel === item} onClick={() => chooseChannel(item)}>
                    {CHANNEL_TEXT[item]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <NumberOpen
            entryKey={entryKey}
            displayed={displayed}
            draft={numberDraft}
            onDraft={(draft) => {
              memory.numberDraft = draft
              setNumberDraft(draft)
            }}
            inputRef={numberInputRef}
            onOpen={openNumber}
          />
        </div>
        <div className="search-page-side" hidden={side !== 'local'}>
          <div className="search-page-scroll" ref={localScrollRef} onScroll={onLocalScroll}>
            <SearchBody
              className="search-page-body"
              tabId={tabId}
              tab={tab}
              view="local"
              displayed={displayed && side === 'local'}
              rebuild={host.state.rebuild}
              commands={host.commands}
              forums={host.forums}
              focusRefs={{ input: localInputRef, list: localListRef }}
              tabMenu
            />
          </div>
        </div>
        <div className="search-page-side" hidden={side !== 'online'}>
          <OnlineSearchPane
            key={channel}
            entryKey={entryKey}
            session={online.session(channel)}
            displayed={displayed && side === 'online'}
            takeFocus={!channelSwitched.current}
            directory={directory}
            onOpen={onOpen}
          />
        </div>
      </div>
    </section>
  )
}
