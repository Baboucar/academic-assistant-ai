// Node 25+ ships its own localStorage global, which hides jsdom's and has no
// usable storage unless Node gets a file for it. Point the globals back at jsdom.
for (const name of ['localStorage', 'sessionStorage']) {
  const storage = globalThis.jsdom?.window?.[name]
  if (storage && globalThis[name] !== storage) {
    Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true })
  }
}
