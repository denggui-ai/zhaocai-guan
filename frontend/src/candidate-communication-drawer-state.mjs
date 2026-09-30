export function communicationDrawerEscapeAction({ key, busy = false, nestedLayerOpen = false } = {}) {
  if (key !== 'Escape') return 'ignore';
  if (busy) return 'block';
  if (nestedLayerOpen) return 'nested';
  return 'close';
}
