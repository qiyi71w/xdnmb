// Trial builds only (VITE_XIDAO_PROTOTYPE=1): page secondary buttons (`.btn-page`; the list-head
// actions also carry `.list-head-btn`) switch between candidate looks, compared on a real machine
// before one is kept. The choice is the root element's `data-button-style` for this run only:
// nothing is saved, every launch starts at 现状. styles/button-styles.css draws the candidates.

export const BUTTON_STYLE_TRIAL = import.meta.env.VITE_XIDAO_PROTOTYPE === '1'

export type ButtonStyle = 'current' | 'a' | 'b' | 'c' | 'd' | 'e'

export const BUTTON_STYLE_OPTIONS: readonly { value: ButtonStyle; label: string }[] = [
  { value: 'current', label: '现状' },
  { value: 'a', label: 'A 安静墨字' },
  { value: 'b', label: 'B 浅灰实底' },
  { value: 'c', label: 'C 细线幽灵' },
  { value: 'd', label: 'D 图标优先' },
  { value: 'e', label: 'E 推荐' }
]

export function currentButtonStyle(): ButtonStyle {
  const value = document.documentElement.dataset.buttonStyle
  return BUTTON_STYLE_OPTIONS.find((option) => option.value === value)?.value ?? 'current'
}

export function applyButtonStyle(style: ButtonStyle): void {
  document.documentElement.dataset.buttonStyle = style
}
