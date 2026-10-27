/**
 * The userhash as sent in `Cookie: userhash=…`. The forum's own export (and the account page it
 * comes from) writes a space in the cookie as `+`, while the browser sends it as `%20`, and only the
 * browser form is accepted. Every `+` becomes `%20`; nothing else (including `%7E`) changes.
 * Stored values keep the form they were imported in; this is applied wherever the cookie is sent
 * and wherever two userhashes are compared.
 */
export function userhashCookieValue(userhash: string): string {
  return userhash.replaceAll('+', '%20')
}
