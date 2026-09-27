import { useCallback, useMemo, useRef } from 'react';
import { useSession } from '@clerk/clerk-react';

// Thin authenticated fetch helper for the serverless API. Injects the Clerk
// session JWT as `Authorization: Bearer <token>` and parses JSON responses.
export function useApi() {
  const { session } = useSession();
  const tokenFnRef = useRef<(() => Promise<string | null>) | null>(null);

  if (session) {
    tokenFnRef.current = () => session.getToken();
  }

  const call = useCallback(async (method: string, path: string, body?: unknown) => {
    if (!path.startsWith('/')) path = '/' + path;
    const token = (await tokenFnRef.current?.()) || null;
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('Your sign-in has expired. Reload the page and sign in again.');
      }
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }, []);

  // Stable for the life of the session: callers put `api` in useCallback and
  // useEffect dependency lists, and a fresh object on every render would tear
  // down and rebuild every one of those effects on every render.
  return useMemo(
    () => ({
      get: (p: string) => call('GET', p),
      post: (p: string, b?: unknown) => call('POST', p, b ?? {}),
      patch: (p: string, b?: unknown) => call('PATCH', p, b ?? {}),
      del: (p: string) => call('DELETE', p),
    }),
    [call]
  );
}