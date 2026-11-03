"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getApiProblem, isDemo, subscribeApiProblem, subscribeDemo } from "./core";
import { useStore } from "./store";

/** One-shot async load. Returns { data, error, loading, reload }. */
/*
 * These are generic data-fetching hooks: the dependency array is supplied by the
 * caller, so it can never be an array literal here. biome's top-level suppression
 * has to be line 1, which "use client" already occupies, so the rule is set to a
 * warning for apps/dashboard/lib in biome.json instead.
 */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  useEffect(() => {
    // Reset on setup, not only on cleanup: under React StrictMode the effect runs
    // setup → cleanup → setup, so a cleanup-only reset would leave `alive` false for
    // good and every resolved fetch would skip setState (perpetual skeletons). This
    // also restores liveness when the component unmounts and remounts (route revisit).
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (silent) => {
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (alive.current) setState((s) => ({ data: silent ? s.data : null, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    run(false);
  }, deps);
  return { ...state, reload: () => run(true) };
}

/** The slowest a page should poll while the stream is carrying pushes for it. */
const POLL_LIVE_MS = 30_000;

/**
 * Load immediately, then keep it fresh.
 *
 * `ms` is the cadence for when the stream is DOWN — then polling is the only way to
 * see a change. While the stream is up, this falls back to a slow safety poll and
 * relies on `rev` instead: the store bumps it whenever a frame arrives that
 * invalidates data pages fetch themselves (blocklist, audit, attackers, system), so
 * a change shows up on the push rather than on the next tick.
 */
export function usePolling(fn, ms = 5000, deps = []) {
  const { conn, rev } = useStore();
  const a = useAsync(fn, deps);
  const reload = a.reload;
  const live = conn === "live" || conn === "demo";
  const every = live ? Math.max(ms, POLL_LIVE_MS) : ms;

  useEffect(() => {
    const t = setInterval(reload, every);
    return () => clearInterval(t);
  }, [every, ...deps, reload]);

  // Refetch when the stream says something changed. Skipped on first render:
  // useAsync has already loaded by then.
  const seen = useRef(rev);
  useEffect(() => {
    if (seen.current === rev) return;
    seen.current = rev;
    reload();
  }, [rev, reload]);

  return a;
}

/** Ticking clock so relative labels ("5s ago") stay honest. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useDemo() {
  return useSyncExternalStore(subscribeDemo, isDemo, () => false);
}

/** The worst current API failure ({ kind, message }), or null. */
export function useApiProblem() {
  return useSyncExternalStore(subscribeApiProblem, getApiProblem, () => null);
}

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* noop */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);
  return [copied, copy];
}
