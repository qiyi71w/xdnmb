import { createContext, useContext, useLayoutEffect, useMemo, useRef, type Dispatch, type ReactNode } from 'react'
import type { PostId } from '../../../../shared/forum'
import { useSettings } from '../../lib/settingsContext'
import { revealsOn, type ImageRevealsAction, type PageReveals, type RevealView } from './imageMaskState'

/** 图片遮罩 of the reading thumbnails of one tab's page (its reader, lists and quote card). */
export interface ImageMask {
  /** Whether masking is on (enabled at an opacity above 0%). */
  active: boolean
  /** Opacity in percent of the cover over the thumbnail of `postId`; null when it is not masked now. */
  cover: (postId: PostId) => number | null
  reveal: (postId: PostId) => void
  /** Ends the visit of the page: it switched to another of its own local pages (`useImageMaskSubpage`). */
  leave: () => void
  /** The page visit (see `PageReveals.visit`); a viewer of the original closes when it changes. */
  visit: number
}

const ImageMaskContext = createContext<ImageMask | null>(null)

export function useImageMask(): ImageMask {
  const mask = useContext(ImageMaskContext)
  if (mask === null) throw new Error('useImageMask outside ImageMaskScope')
  return mask
}

/**
 * A page with local pages of its own (历史 浏览／新串／回复, 订阅 list／同步与合并): switching from
 * `subpage` to another one leaves the page's visit, before paint, like a page change of the tab.
 * Its images are masked again and a viewer of the original opened there closes.
 */
export function useImageMaskSubpage(subpage: string): void {
  const { leave } = useImageMask()
  const shown = useRef(subpage)
  useLayoutEffect(() => {
    if (shown.current === subpage) return
    shown.current = subpage
    leave()
  }, [subpage, leave])
}

/**
 * The image mask of tab `tabId` showing `view` (`revealView`), for content mounted inside the tab or
 * outside it on its behalf (the quote card of a quote in the tab).
 */
export function ImageMaskScope({
  tabId,
  view,
  reveals,
  dispatch,
  children
}: {
  tabId: number
  view: RevealView | null
  reveals: PageReveals | undefined
  dispatch: Dispatch<ImageRevealsAction>
  children: ReactNode
}) {
  const { imageMaskEnabled, imageMaskOpacity } = useSettings().settings
  const opacity = imageMaskEnabled && imageMaskOpacity > 0 ? imageMaskOpacity : null
  const revealed = revealsOn(reveals, view)
  const visit = reveals?.visit ?? 0
  const page = view?.page ?? null
  const mask = useMemo<ImageMask>(
    () => ({
      active: opacity !== null,
      cover: (postId) => (opacity !== null && !revealed.has(postId) ? opacity : null),
      reveal: (postId) => dispatch({ type: 'reveal', tabId, page, postId }),
      leave: () => dispatch({ type: 'leave', tabId, page }),
      visit
    }),
    [opacity, revealed, visit, dispatch, tabId, page]
  )
  return <ImageMaskContext value={mask}>{children}</ImageMaskContext>
}

/** The cover over a masked thumbnail: the theme's mask colour at the chosen opacity. */
export function ImageMaskCover({ opacity }: { opacity: number }) {
  return <span className="image-mask" style={{ opacity: opacity / 100 }} aria-hidden="true" />
}
