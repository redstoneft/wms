// Tiny external store for connectivity. Combines navigator.onLine with failed
// fetch detection (a Wi-Fi dead zone often keeps navigator.onLine === true).
import { useSyncExternalStore } from 'react';

type Listener = () => void;
let online = typeof navigator === 'undefined' ? true : navigator.onLine;
let lastFailure: number | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function setOnline(v: boolean) {
  if (online !== v) {
    online = v;
    emit();
  }
}

export function reportNetworkFailure() {
  lastFailure = Date.now();
  setOnline(false);
}

export function reportNetworkSuccess() {
  if (!online) setOnline(true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => online,
    () => true,
  );
}

export function getLastFailure() {
  return lastFailure;
}
