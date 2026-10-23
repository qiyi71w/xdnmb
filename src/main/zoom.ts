// Interface zoom of the app window. Keyboard (Ctrl/Cmd + = / - / 0, numpad included), the View menu
// and the settings controls all step through the same factors.
import type { Input, WebContents } from 'electron'
import type { AppPlatform } from '../shared/api'
import { nextZoomFactor, zoomState, type ZoomAction, type ZoomState } from '../shared/settings'

export function currentZoom(contents: WebContents): ZoomState {
  return zoomState(contents.getZoomFactor())
}

export function applyZoom(contents: WebContents, action: ZoomAction): ZoomState {
  const factor = nextZoomFactor(contents.getZoomFactor(), action)
  contents.setZoomFactor(factor)
  return zoomState(factor)
}

/** Zoom action of a key press, or `null`. Only the platform's primary modifier, never Alt. */
export function zoomActionOf(input: Input, platform: AppPlatform): ZoomAction | null {
  if (input.type !== 'keyDown' || input.alt) return null
  const primary = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (!primary) return null
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in'
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'out'
  if (!input.shift && (input.key === '0' || input.code === 'Numpad0' || input.code === 'Digit0')) return 'reset'
  return null
}
