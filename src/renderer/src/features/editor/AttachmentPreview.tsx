// PROTOTYPE (throwaway): the attached image, large, from the float compose panel's thumbnail chip.
// The post image viewer (features/image/ImageViewer.tsx) fetches post images by id, so this is a
// minimal viewer in its look for the local draft copy: fitted to the window (never enlarged), Esc,
// 关闭 or a press beside the image closes it, and focus returns to the chip.

import { useId, useLayoutEffect, useRef, type RefObject } from 'react'
import type { DraftAttachment } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { openLayer } from '../../lib/layers'
import { formatBytes } from '../image/imageView'
import '../image/image.css'

export function AttachmentPreview({
  attachment,
  returnFocus,
  onClose
}: {
  attachment: DraftAttachment
  returnFocus: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const pressedOutside = useRef(false)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const layer = openLayer()
    if (!dialog.open) dialog.showModal()
    const opener = returnFocus.current
    return () => {
      layer.release()
      // Out of the top layer first: the chip behind it is inert until then.
      if (dialog.open) dialog.close()
      opener?.focus({ preventScroll: true })
    }
  }, [returnFocus])

  /** Beside the image: the stage or the dialog itself, not the image or the bars. */
  const outside = (target: EventTarget) => target === dialogRef.current || (target instanceof Element && target.classList.contains('image-viewer-stage'))

  return (
    <dialog
      ref={dialogRef}
      className="image-viewer compose-image-preview"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      // The compose panel's own keys (send, Tab cycling) stay out of the preview.
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        pressedOutside.current = outside(event.target)
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (pressedOutside.current && outside(event.target)) onClose()
        pressedOutside.current = false
      }}
    >
      <div className="image-viewer-bar">
        <h2 className="image-viewer-title compose-image-preview-title" id={titleId}>
          {attachment.originalName}
        </h2>
        <div className="image-viewer-group">
          <button type="button" className="btn btn-small" aria-keyshortcuts="Escape" title="关闭（Esc）" onClick={onClose}>
            <Icon name="close" size={14} />
            关闭
          </button>
        </div>
      </div>
      <div className="image-viewer-stage">
        <img className="image-viewer-thumb" src={attachment.url} alt={`附图：${attachment.originalName}`} draggable={false} />
      </div>
      <div className="image-viewer-footer">
        <p className="image-viewer-info">
          {attachment.width}×{attachment.height} · {attachment.format.toUpperCase()} · {formatBytes(attachment.bytes)}
        </p>
      </div>
    </dialog>
  )
}
