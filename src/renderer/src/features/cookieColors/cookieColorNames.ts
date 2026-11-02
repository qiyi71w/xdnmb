import { COOKIE_COLORS, type CookieColorName } from '../../../../shared/cookieColors'
import { cookieColorToken } from '../../../../shared/theme'

/** 饼干颜色 names as the interface says them (swatch names, screen readers, contrast issues). */
export const COOKIE_COLOR_LABELS: Record<CookieColorName, string> = {
  blue: '蓝',
  teal: '青',
  green: '绿',
  olive: '橄榄',
  amber: '琥珀',
  brown: '棕',
  indigo: '靛',
  violet: '紫'
}

/** What every 饼干颜色 palette offers, in order: 默认 (null), then the eight colors. */
export const COOKIE_COLOR_CHOICES: readonly (CookieColorName | null)[] = [null, ...COOKIE_COLORS]

export function cookieColorLabel(color: CookieColorName | null): string {
  return color === null ? '默认' : COOKIE_COLOR_LABELS[color]
}

/** A swatch's fill: 默认 is the plain 饼干 ID color of the current theme (as `.user-hash`). */
export function cookieSwatchFill(color: CookieColorName | null): string {
  return color === null ? 'var(--ink-2)' : `var(--${cookieColorToken(color)})`
}
