import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { newUuid } from './device';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** URL-synced string param (for filters that should survive refresh). */
export function useQueryParam(name: string, initial = ''): [string, (v: string) => void] {
  const [sp, setSp] = useSearchParams();
  const value = sp.get(name) ?? initial;
  const set = useCallback(
    (v: string) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (v) n.set(name, v);
          else n.delete(name);
          return n;
        },
        { replace: true },
      );
    },
    [name, setSp],
  );
  return [value, set];
}

/**
 * Idempotency key that is generated once per "user action" and reused on
 * retries. Call `next()` after a successful action to start a new one.
 */
export function useIdempotencyKey() {
  const ref = useRef<string>(newUuid());
  const current = useCallback(() => ref.current, []);
  const next = useCallback(() => {
    ref.current = newUuid();
    return ref.current;
  }, []);
  return { current, next };
}

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}
