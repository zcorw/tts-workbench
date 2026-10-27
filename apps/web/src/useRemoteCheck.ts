import { useCallback, useEffect, useRef, useState } from 'react';

// Poll JSON only. A hidden tab has no timer and cannot install a late response.
// Callers decide whether to offer an update; this hook never replaces a draft.
export function useRemoteCheck<T>({
  enabled,
  key,
  load,
  onValue,
  onError,
  intervalMs = 20000,
}: {
  enabled: boolean;
  key: string;
  load: () => Promise<T>;
  onValue: (value: T) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
}) {
  const callbacks = useRef({ load, onValue, onError });
  callbacks.current = { load, onValue, onError };
  const trigger = useRef<() => Promise<void>>(async () => {});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      if (!disposed && enabled && visible())
        timer = setTimeout(() => void check(), Math.max(15000, intervalMs));
    };
    async function check() {
      if (disposed || !enabled || !visible() || running) return;
      clear();
      const current = generation;
      running = true;
      setChecking(true);
      try {
        const value = await callbacks.current.load();
        if (!disposed && current === generation && visible()) {
          setError('');
          callbacks.current.onValue(value);
        }
      } catch (cause) {
        if (!disposed && current === generation && visible()) {
          setError('暂时无法检查远端更新；保存时仍会检查版本。');
          callbacks.current.onError?.(cause);
        }
      } finally {
        running = false;
        if (!disposed) {
          setChecking(false);
          // A visible event during a hidden in-flight request needs a fresh read.
          if (current !== generation && enabled && visible()) void check();
          else schedule();
        }
      }
    }
    const visibility = () => {
      generation++;
      clear();
      if (visible()) void check();
    };
    const focus = () => void check();
    trigger.current = check;
    setChecking(false);
    setError('');
    if (enabled) {
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('focus', focus);
      void check();
    }
    return () => {
      disposed = true;
      generation++;
      clear();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus);
      trigger.current = async () => {};
    };
  }, [enabled, key, intervalMs]);
  const check = useCallback(() => trigger.current(), []);
  return { checking, error, check };
}
