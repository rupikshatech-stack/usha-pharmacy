import { useEffect, useState } from 'react';
import { useDebounced } from '../../hooks/useFetch';
import { platformService } from '../../services/platformService';

/**
 * What is already on this installation that looks like what is being typed.
 *
 * The server refuses a duplicate name or a taken email with a 409, which is correct but late: by then the
 * operator has filled in a whole form, often while the pharmacy waits on the telephone. This asks the same
 * question quietly as they type, so the answer arrives while it is still cheap to act on.
 *
 * It is deliberately advisory. It never blocks the form, because a near-match is frequently a real second
 * branch of a real business — "Shree Medical" and "Shree Medical Stores" can both be genuine customers. The
 * server remains the only thing that refuses anything.
 */
export function useSimilarOrganizations(term, { minLength = 3, enabled = true, limit = 5 } = {}) {
  const query = useDebounced(term.trim(), 400);
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!enabled || query.length < minLength) {
      setItems([]);
      return undefined;
    }
    let alive = true;
    platformService
      .listOrganizations({ search: query, limit })
      .then((d) => alive && setItems(d?.items || []))
      // A lookup that fails is not worth a word: it is a hint, and the server still checks on submit.
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [query, minLength, enabled, limit]);

  return items;
}

/** The one already here whose name is the same but for case and spacing, if there is one. */
export const exactName = (items, typed) => {
  const want = typed.trim().toLowerCase().replace(/\s+/g, ' ');
  return items.find((o) => String(o.name).toLowerCase().replace(/\s+/g, ' ') === want) || null;
};

/** The one already administered by this address, if there is one. */
export const exactEmail = (items, typed) => {
  const want = typed.trim().toLowerCase();
  return want ? items.find((o) => String(o.ownerEmail || '').toLowerCase() === want) || null : null;
};
