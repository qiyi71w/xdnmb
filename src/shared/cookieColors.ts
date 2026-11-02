// 饼干颜色: the 饼干 IDs the user keeps in a list on this computer, each shown in 默认 (the
// theme's ordinary 饼干 ID text color) or in one of the palette colors. It only colors that ID's text.

/** The palette, by name. Storage keeps the name, never a color value; no red family (red is the admin's). */
export const COOKIE_COLORS = ['blue', 'teal', 'green', 'olive', 'amber', 'brown', 'indigo', 'violet'] as const

export type CookieColorName = (typeof COOKIE_COLORS)[number]

/** Given once to each imported cookie's 饼干 ID; all imported cookies share it. */
export const IMPORTED_COOKIE_COLOR: CookieColorName = 'blue'

export function isCookieColorName(value: unknown): value is CookieColorName {
  return typeof value === 'string' && (COOKIE_COLORS as readonly string[]).includes(value)
}

/**
 * A listed 饼干 ID, matched verbatim (case-sensitive). `color` null is 默认: no color of its own,
 * the ordinary 饼干 ID text color of the current theme. `createdAt` is when it was added.
 */
export interface CookieColor { cookieId: string; color: CookieColorName | null; createdAt: string }

/** Every call rejects an ID outside the 饼干 ID rules (untrimmed included). */
export interface CookieColorsApi {
  /** Every listed 饼干 ID, oldest first. */
  list(): Promise<CookieColor[]>
  /**
   * Adds one 饼干 ID in 默认. An ID already listed keeps its color, place and date: `added` is
   * false then.
   */
  add(input: { cookieId: string }): Promise<{ saved: true; added: boolean } | { saved: false }>
  /**
   * Gives one 饼干 ID a palette color, or 默认 with `null`. A listed ID keeps its place and date;
   * an unlisted one is added. Rejects an unknown color name.
   */
  set(input: { cookieId: string; color: CookieColorName | null }): Promise<{ saved: boolean }>
  /** Takes one 饼干 ID off the list (nothing to do when it is not listed). */
  remove(input: { cookieId: string }): Promise<{ saved: boolean }>
}
