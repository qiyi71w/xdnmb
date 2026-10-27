import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import './styles/tokens.css'
import './styles/base.css'
import './styles/button-styles.css'
import { App } from './app/App'
import { applyButtonStyle, BUTTON_STYLE_TRIAL } from './lib/buttonStyle'
import { applyAppearance } from './lib/useAppearance'

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root element')

// Themed first paint; the stored settings replace these once `settings.get()` resolves.
applyAppearance(DEFAULT_SETTINGS)
// Trial builds compare button looks; every launch starts at 现状 (lib/buttonStyle.ts).
if (BUTTON_STYLE_TRIAL) applyButtonStyle('current')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
