// Small authored line icons: 24px grid, 1.7 stroke, round caps. Always decorative (aria-hidden).

const PATHS = {
  timeline: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  forum: <path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m20.5 16-4.5-4.5L7 19" />
    </>
  ),
  reply: <path d="M5 5.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8.5L6 20v-3.5H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />,
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  toTop: (
    <>
      <path d="M5 4.5h14" />
      <path d="M12 20V9M7 13.5l5-5 5 5" />
    </>
  ),
  toEnd: (
    <>
      <path d="M5 19.5h14" />
      <path d="M12 4v11M7 10.5l5 5 5-5" />
    </>
  ),
  arrowUp: <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />,
  arrowRight: <path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5" />,
  arrowLeft: <path d="M19 12H5M10.5 6.5 5 12l5.5 5.5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  fit: <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />,
  download: (
    <>
      <path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M9.5 5v14M5.8 9h1.6M5.8 12h1.6" />
    </>
  ),
  split: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M11 5v14" />
    </>
  ),
  settings: (
    <>
      <path d="M4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20" />
      <circle cx="15" cy="8" r="2.2" />
      <circle cx="9" cy="16" r="2.2" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V13M12 16.4v.1" />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1" />
      <path d="M5 8.5v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </>
  ),
  external: (
    <>
      <path d="M13.5 5H19v5.5M19 5l-8 8" />
      <path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  draft: (
    <>
      <path d="M13 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-6" />
      <path d="m17.5 4.5 2 2-7.5 7.5-2.7.7.7-2.7 7.5-7.5Z" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15M10 4.5h4M6.5 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  key: (
    <>
      <circle cx="8.5" cy="12" r="3.5" />
      <path d="M12 12h8.5M17.5 12v3M20.5 12v2.5" />
    </>
  ),
  star: <path d="m12 4.5 2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.8-3.6 5.2-.8L12 4.5Z" />,
  history: (
    <>
      <path d="M4.8 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9.2" />
      <path d="M4.5 5v4.2h4.2M12 8v4.3l2.8 1.7" />
    </>
  ),
  bookmark: <path d="M7 4.5h10a1 1 0 0 1 1 1V19.5l-6-4-6 4V5.5a1 1 0 0 1 1-1Z" />,
  send: <path d="M4.5 12 19.5 5l-4 14-3.8-5.7L4.5 12Zm7.2 1.3L19.5 5" />,
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </>
  ),
  bell: (
    <>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5h-14l1.5-1.5Z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
    </>
  ),
  filter: <path d="M4.5 6h15M7.5 12h9M10.5 18h3" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M4.5 12h15M12 4.5c2.1 2.1 3.2 4.6 3.2 7.5s-1.1 5.4-3.2 7.5c-2.1-2.1-3.2-4.6-3.2-7.5s1.1-5.4 3.2-7.5Z" />
    </>
  )
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/** Spinner that stays a static ring under reduced motion; always paired with visible text. */
export function Spinner() {
  return (
    <svg className="spinner" width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
