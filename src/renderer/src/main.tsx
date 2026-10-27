import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import './styles/tokens.css'
import './styles/base.css'
import './styles/page-buttons.css'
import { App } from './app/App'
import { applyAppearance } from './lib/useAppearance'

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root element')

// Themed first paint; the stored settings replace these once `settings.get()` resolves.
applyAppearance(DEFAULT_SETTINGS)

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
