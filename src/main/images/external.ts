/** Longest external image address accepted. */
const MAX_EXTERNAL_URL_LENGTH = 2048

/**
 * An image address on a public third-party host (版规 images live on image hosts of their own):
 * https on the default port, a host name rather than an address literal, no credentials. An
 * `http:` address is taken as its `https:` form; nothing is ever requested in the clear. Local
 * names (`localhost`, single-label names) are refused. Returns null for anything else.
 */
export function publicHttpsUrl(raw: string): URL | null {
  if (raw.length > MAX_EXTERNAL_URL_LENGTH || !URL.canParse(raw.trim())) return null
  const url = new URL(raw.trim())
  if (url.protocol === 'http:' && url.port === '') url.protocol = 'https:'
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null
  // URL parsing already turns every numeric IPv4 form into dotted decimal and keeps IPv6 in brackets.
  const host = url.hostname.replace(/\.$/, '').toLowerCase()
  if (host === '' || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) return null
  url.hash = ''
  return url
}
