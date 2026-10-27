import type { CSSProperties } from 'react'
import { cookieColorToken } from '../../../shared/theme'
import { useCookieColor } from '../features/cookieColors/cookieColorsStore'

/**
 * A 饼干 ID as shown everywhere (post headers, quote cards, thread and history rows, settings):
 * an admin's in the danger color, else in its 饼干颜色 when it has one, else in the plain ID color.
 * The color stays in selected and highlighted states.
 */
export function CookieId({ cookieId, admin = false }: { cookieId: string; admin?: boolean }) {
  const color = useCookieColor(cookieId)
  if (admin) return <span className="user-hash is-admin">{cookieId}</span>
  if (color === undefined) return <span className="user-hash">{cookieId}</span>
  const style = { '--cookie-color': `var(--${cookieColorToken(color)})` } as CSSProperties
  return (
    <span className="user-hash is-colored" style={style}>
      {cookieId}
    </span>
  )
}
