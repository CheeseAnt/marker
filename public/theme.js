// Applies the saved theme before the page first paints, so a dark board doesn't flash light.
// The app keeps it up to date afterwards (src/ui/theme.ts).
;(function () {
  var theme = 'system'
  try {
    theme = JSON.parse(localStorage.getItem('marker.settings') || localStorage.getItem('boardbot.settings') || '{}').theme || 'system'
  } catch (e) {
    // Unreadable settings fall back to the system theme.
  }
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()
