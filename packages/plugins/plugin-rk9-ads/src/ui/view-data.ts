/**
 * Loads a read view through an action (RK9-583). The views are actions, not
 * data handlers, so the worker takes the company from the host's
 * `context.companyId` (features/ui/register.ts); a data handler gets only
 * params. The result has the shape of usePluginData: data, loading, error
 * and refresh.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./format.js";

export interface ViewData<T> {
  /** Null while the first load runs, after an error, and while another company loads. */
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Loads the view again; the shown data stays until the new one arrives. */
  refresh(): void;
}

interface Loaded<T> {
  /** The key and company the state belongs to: data of another company is never shown. */
  scope: string;
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/** `companyId` scopes the reload only: the host sends its own company with the action. */
export function useViewData<T>(key: string, companyId: string | null | undefined): ViewData<T> {
  const load = usePluginAction(key);
  const loadRef = useRef(load);
  loadRef.current = load;
  const scope = `${key}\u0000${companyId ?? ""}`;
  const [state, setState] = useState<Loaded<T>>({ scope, data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!companyId) {
      setState({ scope, data: null, loading: false, error: new Error("company context is required") });
      return;
    }
    let current = true;
    setState((prev) => (prev.scope === scope ? { ...prev, loading: true } : { scope, data: null, loading: true, error: null }));
    loadRef.current({}).then(
      (data) => {
        if (current) setState({ scope, data: data as T, loading: false, error: null });
      },
      (cause: unknown) => {
        if (current) setState({ scope, data: null, loading: false, error: new Error(errorText(cause)) });
      },
    );
    return () => {
      current = false;
    };
  }, [scope, companyId, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const own = state.scope === scope;
  return { data: own ? state.data : null, loading: own ? state.loading : true, error: own ? state.error : null, refresh };
}
