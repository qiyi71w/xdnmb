import { KAOMOJI_DECOR, type KaomojiDecorState } from '../lib/kaomojiDecor'
import './kaomoji-decor.css'

/**
 * The fixed decorative kaomoji of `state`, in the reading face. Hidden from screen readers, not
 * focusable, not clickable and not selected with the text around it. Inline at the end of a title by
 * default; `above` puts it on its own line above an empty state's title (inside the title element).
 */
export function KaomojiDecor({ state, above = false }: { state: KaomojiDecorState; above?: boolean }) {
  return (
    <span className={above ? 'kaomoji-decor is-above' : 'kaomoji-decor'} aria-hidden="true">
      {KAOMOJI_DECOR[state]}
    </span>
  )
}
