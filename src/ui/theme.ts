import { useEffect, useSyncExternalStore } from 'react'
import { useSettings } from '../settings/store'

export type Theme = 'light' | 'dark'

export const THEME_LABELS = { system: 'Match the system', light: 'Light', dark: 'Dark' } as const

/** The browser's address bar and title bar follow the board's background. */
const THEME_COLOR: Record<Theme, string> = { light: '#f6f7f5', dark: '#1a1d21' }

const query = () => window.matchMedia('(prefers-color-scheme: dark)')

function subscribe(onChange: () => void) {
  const q = query()
  q.addEventListener('change', onChange)
  return () => q.removeEventListener('change', onChange)
}

/**
 * The theme in use: the setting, or the system's when it's "system". Marks the page with
 * data-theme, which the stylesheet's dark palette keys off (public/theme.js does the same
 * before the first paint).
 */
export function useTheme(): Theme {
  const setting = useSettings((s) => s.settings.theme)
  const systemDark = useSyncExternalStore(subscribe, () => query().matches)
  const theme: Theme = setting === 'system' ? (systemDark ? 'dark' : 'light') : setting
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
  }, [theme])
  return theme
}
