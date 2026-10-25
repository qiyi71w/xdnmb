import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject
} from 'react'
import { Icon } from '../../components/Icon'

const MAX_SCALE = 8
const MIN_SCALE = 0.1
const STEP = 1.25
/** Free space kept around the image when it is fitted to the stage. */
const FIT_PADDING = 16
const PAN_STEP = 60
const PAN_STEP_LARGE = 240

export interface Size {
  w: number
  h: number
}

/** `fit` follows the stage size; `manual` keeps a scale and the image's top-left corner on the stage. */
type Zoom = { mode: 'fit' } | { mode: 'manual'; scale: number; x: number; y: number }

interface Placement {
  scale: number
  x: number
  y: number
}

function fitScale(natural: Size, stage: Size): number {
  return Math.max(Math.min(1, (stage.w - 2 * FIT_PADDING) / natural.w, (stage.h - 2 * FIT_PADDING) / natural.h), 0.01)
}

function minScale(natural: Size, stage: Size): number {
  return Math.min(MIN_SCALE, fitScale(natural, stage))
}

/** A dimension smaller than the stage is centred; a larger one may not leave a gap at either edge. */
function clampOffset(offset: number, length: number, stageLength: number): number {
  if (length <= stageLength) return (stageLength - length) / 2
  return Math.min(0, Math.max(stageLength - length, offset))
}

function place(zoom: Zoom, natural: Size, stage: Size): Placement {
  if (zoom.mode === 'fit') {
    const scale = fitScale(natural, stage)
    return { scale, x: (stage.w - natural.w * scale) / 2, y: (stage.h - natural.h * scale) / 2 }
  }
  return {
    scale: zoom.scale,
    x: clampOffset(zoom.x, natural.w * zoom.scale, stage.w),
    y: clampOffset(zoom.y, natural.h * zoom.scale, stage.h)
  }
}

/** Scale around a stage point (the pointer, or the stage centre), keeping that point of the image under it. */
function zoomAround(zoom: Zoom, scale: number, point: { x: number; y: number }, natural: Size, stage: Size): Zoom {
  const current = place(zoom, natural, stage)
  const next = Math.min(MAX_SCALE, Math.max(minScale(natural, stage), scale))
  const ratio = next / current.scale
  return {
    mode: 'manual',
    scale: next,
    x: point.x - (point.x - current.x) * ratio,
    y: point.y - (point.y - current.y) * ratio
  }
}

/**
 * Zoom and pan of one image on a stage, shared by the post image viewer and the compose attachment
 * preview. The image starts fitted to the stage (never enlarged); toolbar, wheel (around the
 * pointer), drag and keys change it. `shown`: the image is decoded and `natural` is its size; until
 * then nothing zooms. The wheel is taken over the whole `containerRef` so nothing under it scrolls.
 */
export function useImageZoom(containerRef: RefObject<HTMLElement | null>, natural: Size | null, shown: boolean) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Size | null>(null)
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null)

  const placement = shown && stage !== null && natural !== null ? place(zoom, natural, stage) : null
  const canPan =
    placement !== null &&
    stage !== null &&
    natural !== null &&
    (natural.w * placement.scale > stage.w + 0.5 || natural.h * placement.scale > stage.h + 0.5)

  // Latest geometry for event handlers registered outside React (wheel).
  const geometry = useRef({ stage, natural, shown })
  useLayoutEffect(() => {
    geometry.current = { stage, natural, shown }
  })

  useLayoutEffect(() => {
    const element = stageRef.current
    if (element === null) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      if (width > 0 && height > 0) setStage((previous) => (previous?.w === width && previous.h === height ? previous : { w: width, h: height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const zoomBy = useCallback((factor: number, point?: { x: number; y: number }) => {
    const { stage, natural, shown } = geometry.current
    if (!shown || stage === null || natural === null) return
    setZoom((previous) => {
      const current = place(previous, natural, stage)
      return zoomAround(previous, current.scale * factor, point ?? { x: stage.w / 2, y: stage.h / 2 }, natural, stage)
    })
  }, [])

  const zoomTo = useCallback((scale: number) => {
    const { stage, natural, shown } = geometry.current
    if (!shown || stage === null || natural === null) return
    setZoom((previous) => zoomAround(previous, scale, { x: stage.w / 2, y: stage.h / 2 }, natural, stage))
  }, [])

  const fit = useCallback(() => setZoom({ mode: 'fit' }), [])

  const panBy = (dx: number, dy: number) => {
    if (!canPan || placement === null) return
    setZoom({ mode: 'manual', scale: placement.scale, x: placement.x + dx, y: placement.y + dy })
  }

  // Wheel over the stage zooms around the pointer; nothing under the container scrolls. Registered
  // natively: React's wheel listener is passive.
  useEffect(() => {
    const container = containerRef.current
    const element = stageRef.current
    if (container === null || element === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { stage } = geometry.current
      if (stage === null || !element.contains(event.target as Node | null)) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.h : 1
      const rect = element.getBoundingClientRect()
      zoomBy(Math.exp(-event.deltaY * unit * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [containerRef, zoomBy])

  /**
   * The zoom keys (+ − 0 1, arrows to pan) and the scrolling keys nothing underneath may act on.
   * Plain keys only; the caller handles modified ones. Returns whether the key was the zoom's.
   */
  const onZoomKey = (event: KeyboardEvent): boolean => {
    const { key } = event
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    switch (key) {
      case '+':
      case '=':
        handled()
        zoomBy(STEP)
        return true
      case '-':
      case '_':
        handled()
        zoomBy(1 / STEP)
        return true
      case '0':
        handled()
        fit()
        return true
      case '1':
        handled()
        zoomTo(1)
        return true
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        handled()
        const step = event.shiftKey ? PAN_STEP_LARGE : PAN_STEP
        // Arrows move the view like scrolling: → shows more of the right side.
        if (key === 'ArrowLeft') panBy(step, 0)
        else if (key === 'ArrowRight') panBy(-step, 0)
        else if (key === 'ArrowUp') panBy(0, step)
        else panBy(0, -step)
        return true
      }
      case 'PageUp':
      case 'PageDown':
      case 'Home':
      case 'End':
        // Nothing underneath may scroll.
        event.preventDefault()
        return true
    }
    return false
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPan || placement === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: placement.x, y: placement.y }
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId || placement === null) return
    setZoom({
      mode: 'manual',
      scale: placement.scale,
      x: current.x + event.clientX - current.startX,
      y: current.y + event.clientY - current.startY
    })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  const imageStyle: CSSProperties | undefined =
    placement === null || natural === null
      ? undefined
      : {
          width: natural.w * placement.scale,
          height: natural.h * placement.scale,
          transform: `translate(${placement.x}px, ${placement.y}px)`
        }

  return {
    stageRef,
    /** Stage class modifiers: ` is-pannable`, ` is-dragging`. */
    stageClass: `${canPan ? ' is-pannable' : ''}${dragging ? ' is-dragging' : ''}`,
    stageHandlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
    imageStyle,
    placement,
    fitted: zoom.mode === 'fit',
    scaleMin: stage !== null && natural !== null ? minScale(natural, stage) : MIN_SCALE,
    zoomBy,
    zoomTo,
    fit,
    onZoomKey
  }
}

/** What the zoom group reads and drives (the result of `useImageZoom` provides it). */
export interface ZoomControlsState {
  /** Null until the image is shown and the stage measured. */
  placement: Placement | null
  scaleMin: number
  fitted: boolean
  zoomBy: (factor: number) => void
  zoomTo: (scale: number) => void
  fit: () => void
}

/** The viewer bar's zoom group: − percentage + 适应窗口 原始大小. */
export function ZoomControls({ zoom }: { zoom: ZoomControlsState }) {
  const { placement, scaleMin, fitted, zoomBy, zoomTo, fit } = zoom
  const percent = placement === null ? null : Math.round(placement.scale * 100)
  return (
    <div className="image-viewer-group" role="group" aria-label="缩放">
      <button
        type="button"
        className="icon-btn"
        aria-label="缩小"
        title="缩小（-）"
        onClick={() => zoomBy(1 / STEP)}
        disabled={placement === null || placement.scale <= scaleMin + 1e-6}
      >
        <Icon name="minus" />
      </button>
      <span className="image-viewer-zoom">
        <span className="visually-hidden">缩放比例 </span>
        {percent === null ? '—' : `${percent}%`}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="放大"
        title="放大（+）"
        onClick={() => zoomBy(STEP)}
        disabled={placement === null || placement.scale >= MAX_SCALE - 1e-6}
      >
        <Icon name="plus" />
      </button>
      <button
        type="button"
        className="btn btn-small"
        title="适应窗口（0）"
        aria-pressed={placement === null ? undefined : fitted}
        onClick={fit}
        disabled={placement === null}
      >
        <Icon name="fit" size={14} />
        适应窗口
      </button>
      <button type="button" className="btn btn-small" title="原始大小（1）" onClick={() => zoomTo(1)} disabled={placement === null}>
        原始大小
      </button>
    </div>
  )
}
