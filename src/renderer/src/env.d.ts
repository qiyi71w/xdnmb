import type { XidaoApi } from '../../shared/api'

declare global {
  interface Window {
    xidao: XidaoApi
  }

  interface ImportMetaEnv {
    /** `1` builds the navigation / settings UI prototype (variant switcher included). */
    readonly VITE_XIDAO_PROTOTYPE?: string
  }
}

export {}
