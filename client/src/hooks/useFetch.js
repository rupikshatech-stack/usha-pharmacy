import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

/** GET helper with loading/error state; refetches when `url` or `params` change. */
export function useFetch(url, params) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const key = JSON.stringify(params || {});
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .get(url, { params: JSON.parse(key) })
      .then((d) => id === seq.current && setData(d))
      .catch((e) => id === seq.current && setError(e.message))
      .finally(() => id === seq.current && setLoading(false));
  }, [url, key]);

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
