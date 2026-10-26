// Excalidraw registers its fonts as soon as its module loads, so this classic script runs first
// (before any module script) to make them load from this app instead of a CDN.
window.EXCALIDRAW_ASSET_PATH = '/'
