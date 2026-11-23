import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

/**
 * GET helper with loading/error state; refetches when `url` or `params` change.
 *
 * `enabled: false` makes no request at all (data stays null, loading is false): for a screen that would otherwise ask
 * for something the signed-in user is already known not to be allowed, which can only fail.
 */
export function useFetch(url, params, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const key = JSON.stringify(params || {});
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .get(url, { params: JSON.parse(key) })
      .then((d) => id === seq.current && setData(d))
      .catch((e) => id === seq.current && setError(e.message))
      .finally(() => id === seq.current && setLoading(false));
  }, [url, key, enabled]);

  useEffect(load, [load]);
  return { data, loading, error, reload: load };
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
