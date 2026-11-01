// Build-time configuration of the main process (electron-vite `MAIN_VITE_*` variables).
interface ImportMetaEnv {
  /** Origin of the voluntary usage-statistics service; unset builds have statistics unavailable. */
  readonly MAIN_VITE_XIDAO_ANALYTICS_ORIGIN?: string
}
