import { fileURLToPath } from 'node:url'

export interface AppDocumentOptions {
  /** The renderer page the main window loads with `loadFile`. */
  rendererFile: string
  /** Development server; when set, any page of its origin is the app's document. */
  devUrl?: string | undefined
  /** Windows path rules (`process.platform === 'win32'`). */
  windows: boolean
}

/**
 * Whether a frame URL is the app's own renderer document (query and fragment ignored).
 *
 * The URL is compared as the file it names, not as text. Chromium writes the URL of a `loadFile`
 * page its own way: it leaves `~`, `[` and `]` unescaped where Node's `pathToFileURL` escapes them,
 * and uppercases a Windows drive letter, while the renderer path keeps the spelling the app was
 * started with (a lowercase drive, an 8.3 short folder name). Only the drive letter's case is
 * ignored; everything else must be the same path. A path that cannot be read back (an encoded
 * separator, a malformed escape, a remote host) is never the app's document, so a folder name
 * with a literal `%` is refused.
 */
export function createAppDocumentMatcher({ rendererFile, devUrl, windows }: AppDocumentOptions): (url: string) => boolean {
  if (devUrl) {
    const origin = new URL(devUrl).origin
    return (url) => URL.canParse(url) && new URL(url).origin === origin
  }
  const expected = upperDrive(rendererFile, windows)
  return (url) => {
    if (!URL.canParse(url)) return false
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    try {
      return upperDrive(fileURLToPath(parsed, { windows }), windows) === expected
    } catch {
      return false
    }
  }
}

function upperDrive(path: string, windows: boolean): string {
  return windows ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : path
}
