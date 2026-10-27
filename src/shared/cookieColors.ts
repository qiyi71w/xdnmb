// 饼干标色: a color the user gives a 饼干 ID on this computer. It only colors that ID's text.

/** The palette, by name. Storage keeps the name, never a color value; no red family (red is the admin's). */
export const COOKIE_COLORS = ['blue', 'teal', 'green', 'olive', 'amber', 'brown', 'indigo', 'violet'] as const

export type CookieColorName = (typeof COOKIE_COLORS)[number]

/** Given once to each imported cookie's 饼干 ID; all imported cookies share it. */
export const DEFAULT_COOKIE_COLOR: CookieColorName = 'blue'

export function isCookieColorName(value: unknown): value is CookieColorName {
  return typeof value === 'string' && (COOKIE_COLORS as readonly string[]).includes(value)
}

/** A colored 饼干 ID, matched verbatim (case-sensitive). `createdAt` is when it was first colored. */
export interface CookieColor { cookieId: string; color: CookieColorName; createdAt: string }

export interface CookieColorsApi {
  /** Every colored 饼干 ID, oldest first. */
  list(): Promise<CookieColor[]>
  /**
   * Colors one 饼干 ID (an already colored ID keeps its place and changes color), or clears it with
   * `null`. Rejects an unknown color name or an ID outside the 饼干 ID rules (untrimmed included).
   */
  set(input: { cookieId: string; color: CookieColorName | null }): Promise<{ saved: boolean }>
}
