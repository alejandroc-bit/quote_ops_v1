import { useCallback, useEffect, useState } from "react";

export type AsyncResourceState<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
};

export function useAsyncResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
  autoRefreshMs: number | null = null
): AsyncResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    load()
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [load, reloadToken, ...deps]);

  useEffect(() => {
    if (!autoRefreshMs) return;
    const interval = window.setInterval(() => {
      setReloadToken((current) => current + 1);
    }, autoRefreshMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [autoRefreshMs]);

  return { data, error, loading, reload };
}
