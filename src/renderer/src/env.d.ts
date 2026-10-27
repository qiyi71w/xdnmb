import type { XidaoApi } from '../../shared/api'

declare global {
  interface Window {
    xidao: XidaoApi
  }

  interface ImportMetaEnv {
    /** '1' in trial builds: prototype-only choices appear (lib/buttonStyle.ts). */
    readonly VITE_XIDAO_PROTOTYPE?: string
  }
}

export {}
