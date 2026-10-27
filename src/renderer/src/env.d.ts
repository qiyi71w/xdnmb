import type { XidaoApi } from '../../shared/api'

declare global {
  interface Window {
    xidao: XidaoApi
  }
}

export {}
