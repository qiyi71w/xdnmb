import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { BUILTIN_PALETTES, themeFromBuiltin, type CustomTheme } from '../../src/shared/theme'
import { applyAppearance, previewTheme } from '../../src/renderer/src/lib/useAppearance'

const sepia: CustomTheme = {
  name: '旧纸',
  colors: {
    light: { background: '#efe6d6', surface: '#fbf6ec', text: '#2b2118', secondaryText: '#5a4a3a', accent: '#7a3e12' },
    dark: themeFromBuiltin('dark').colors.dark
  },
  opacity: 0.7,
  radius: 10
}

describe('theme preview', () => {
  it('previews without writing settings and restores the latest appearance when discarded', () => {
    const variables = new Map<string, string>()
    const root = { style: { setProperty: (name: string, value: string) => variables.set(name, value) }, dataset: {} }
    vi.stubGlobal('document', { documentElement: root })
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), xidao: { view: { updateTitleBar: async () => undefined } } })
    try {
      const settings = { ...DEFAULT_SETTINGS, colorScheme: 'light' as const }
      applyAppearance(settings)
      const original = variables.get('--paper')
      previewTheme(sepia)
      expect(variables.get('--paper')).toBe(sepia.colors.light.surface)
      expect(settings.customTheme).toBeNull()
      applyAppearance({ ...settings, colorScheme: 'dark' })
      expect(variables.get('--paper')).toBe(sepia.colors.dark.surface)
      previewTheme(null)
      expect(variables.get('--paper')).toBe(BUILTIN_PALETTES.dark.paper)
      expect(variables.get('--paper')).not.toBe(original)
    } finally {
      previewTheme(null)
      vi.unstubAllGlobals()
    }
  })
})
