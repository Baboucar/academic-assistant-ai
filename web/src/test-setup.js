// Node 25+ ships its own localStorage global, which hides jsdom's and has no
// usable storage unless Node gets a file for it. Point the globals back at jsdom.
for (const name of ['localStorage', 'sessionStorage']) {
  const storage = globalThis.jsdom?.window?.[name]
  if (storage && globalThis[name] !== storage) {
    Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true })
  }
}

// Browser APIs the UI components expect that jsdom does not implement
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.matchMedia ??= (query) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
