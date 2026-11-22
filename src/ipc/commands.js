// Centralized IPC boundary between frontend and Tauri v2 Rust backend.
// Provides a safe in-memory mock fallback only when running outside Tauri (browser dev mode).

const rawInvoke =
  (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
  || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
  || (window.__TAURI__ && window.__TAURI__.invoke)
  || null;

export const hasTauri = typeof rawInvoke === 'function';

const devVault = new Map();

async function devMockInvoke(cmd, args = {}) {
  switch (cmd) {
    case 'app_build': return { version: 'dev', time: '' };
    case 'net_check': return navigator.onLine;
    case 'autostart_get': return false;
    case 'autostart_set': return true;
    case 'vault_get': return devVault.get(args.key) ?? null;
    case 'vault_set': devVault.set(args.key, args.value); return true;
    case 'vault_clear':
      for (const k of [...devVault.keys()]) if (k.startsWith(args.prefix || '')) devVault.delete(k);
      return true;
    case 'rec_encoders': return [{ id: 'ts', label: 'TS (original, no transcoding)', ext: 'ts' }];
    case 'rec_status': return {};
    case 'default_rec_dir': return '.';
    default: return null;
  }
}

export function invoke(cmd, args) {
  if (hasTauri) return rawInvoke(cmd, args);
  return devMockInvoke(cmd, args);
}

/**
 * Subscribe to a Tauri backend event (e.g. 'rec-progress').
 * Returns an unlisten function (no-op outside Tauri).
 */
export async function listen(event, handler) {
  const evApi = window.__TAURI__ && window.__TAURI__.event;
  if (evApi && typeof evApi.listen === 'function') {
    return await evApi.listen(event, (e) => handler(e && e.payload));
  }
  const internals = window.__TAURI_INTERNALS__;
  if (internals && typeof internals.transformCallback === 'function' && hasTauri) {
    const cbId = internals.transformCallback((e) => handler(e && e.payload));
    const eventId = await rawInvoke('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: cbId,
    });
    return () => rawInvoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
  }
  return () => {};
}
