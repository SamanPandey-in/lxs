"use client";
// External live store: REST bootstrap + SSE (or a simulated stream in demo mode) -> useStore().
import { useSyncExternalStore } from "react";
import { api, isDemo, PROJECT, resolveProject, streamUrl, subscribeDemo } from "./core";
import { nextLiveEvent } from "./mock";
import { connectStream } from "./sse";

const MAX_EVENTS = 300;
const REFRESH_ON = new Set([
  "incident.ai",
  "incident.ai_ready",
  "action.applied",
  "action.updated",
  "sensor.status",
  "decoy.health",
  "onboarding.updated",
  "incident.new",
  "incident.updated",
  "incident.upserted",
  "reset",
]);

const s = {
  conn: "connecting",
  demo: false,
  bootstrapped: false,
  // True from the first successful pull. Until then an empty store means "unknown", not "nothing happening".
  loaded: false,
  error: null,
  overview: null,
  incidents: new Map(),
  incidentOrder: [],
  events: [],
  decoys: [],
  liveCount: 0,
  paused: false,
  // Bumped whenever the stream pushes something that invalidates data the store
  // does not carry itself (blocklist, audit, attackers...). Pages watch it instead
  // of polling fast. See usePolling in lib/hooks.js.
  rev: 0,
};

let snapshot = { ...s };
const listeners = new Set();
const SERVER_SNAPSHOT = { ...s };
let started = false;
let stopStream = null;
let ticker = null;
let pending = [];
let flushTimer = null;
let refreshTimer = null;
let pollTimer = null;
let pollEveryMs = 0;
let sawLive = false;
let eventsLoaded = false;
// What the stream itself last reported. A failed REST pull marks us offline; this restores the truth.
let streamConn = "connecting";

/* How often to reconcile over REST.
   The stream is the live path: when it is up, polling is only a safety net against a
   missed frame, so it can be slow. When it is down, polling is the only way the
   analyst sees anything, so it has to be quick. */
const POLL_LIVE_MS = 60_000;
const POLL_DOWN_MS = 7_000;

function publish() {
  snapshot = { ...s, incidents: s.incidents, incidentOrder: s.incidentOrder, events: s.events };
  listeners.forEach((l) => l());
}

const sevRank = { critical: 4, high: 3, medium: 2, low: 1 };
function reorder() {
  s.incidentOrder = [...s.incidents.values()]
    .sort((a, b) => new Date(b.last_event_at) - new Date(a.last_event_at))
    .map((i) => i.id);
}
export const sortBySeverity = (a, b) =>
  sevRank[b.severity] - sevRank[a.severity] ||
  b.score - a.score ||
  new Date(b.last_event_at) - new Date(a.last_event_at);

function normEvent(e) {
  if (!e) return null;
  return {
    fields: {},
    techniques: [],
    tags: [],
    count: 1,
    ...e,
    event_type: e.event_type || e.type,
    occurred_at: e.occurred_at || e.timestamp || e.received_at || new Date().toISOString(),
    received_at: e.received_at || e.occurred_at || new Date().toISOString(),
  };
}

function mergeEvents(incoming) {
  const map = new Map(s.events.map((e) => [e.id, e]));
  incoming.forEach((e) => {
    const n = normEvent(e);
    if (n?.id) map.set(n.id, { ...map.get(n.id), ...n });
  });
  s.events = [...map.values()]
    .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
    .slice(0, MAX_EVENTS);
}

function flush() {
  flushTimer = null;
  if (!pending.length) return;
  if (s.paused) {
    pending = [];
    return;
  }
  const batch = pending;
  pending = [];
  mergeEvents(batch);
  s.liveCount += batch.length;
  publish();
}
function queueEvents(evs) {
  pending.push(...evs);
  if (!flushTimer) flushTimer = setTimeout(flush, 120);
}

/**
 * Pull from REST.
 *
 * `withEvents` refetches the event list, which is by far the largest response the
 * dashboard makes (~19 kB with only 30 events, and it grows). The stream pushes
 * events as they happen, so the periodic reconcile skips it; we only pay for it on
 * first load and after a reconnect, when we may have missed frames.
 */
async function pull({ withEvents } = { withEvents: true }) {
  // A failed first load must not leave the feed empty for good: the reconcile skips events.
  const needEvents = withEvents || !eventsLoaded;
  try {
    const [overview, incidents, decoys, events] = await Promise.all([
      api.overview(PROJECT),
      api.incidents(PROJECT),
      api.decoys(PROJECT),
      needEvents ? api.events(PROJECT) : Promise.resolve(null),
    ]);
    s.overview = overview;
    s.incidents = new Map(incidents.map((i) => [i.id, i]));
    reorder();
    if (events) {
      mergeEvents(events);
      eventsLoaded = true;
    }
    s.decoys = decoys;
    // Crossing between real and mock: events accumulate, so drop the other world's and refetch.
    const crossed = s.loaded && s.demo !== isDemo();
    s.demo = isDemo();
    s.bootstrapped = true;
    s.loaded = true;
    s.error = null;
    syncTransport();
    if (crossed) {
      s.events = [];
      s.liveCount = 0;
      pending = [];
      eventsLoaded = false;
      bootstrap();
    }
  } catch (err) {
    s.error = err;
    s.demo = isDemo();
    if (ticker) syncTransport();
    setConn("offline");
    s.bootstrapped = true;
  }
  publish();
}

const bootstrap = () => pull({ withEvents: true });
const reconcile = () => pull({ withEvents: false });

/**
 * Every connection-state change goes through here so the poll cadence can follow it.
 * Coming back up after a drop triggers one full pull, because frames that arrived
 * while we were disconnected are gone for good.
 */
function setConn(c) {
  if (s.conn === c) return;
  const wasLive = s.conn === "live";
  s.conn = c;
  if (c === "demo") {
    // Keep polling: that is how mock mode notices the API is back.
    schedulePoll();
    return;
  }
  if (c === "live") {
    if (sawLive && !wasLive) bootstrap();
    sawLive = true;
  }
  schedulePoll();
}

/** Interval the current state wants, or null for "do not poll at all". */
function wantedInterval() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return null;
  return s.conn === "live" ? POLL_LIVE_MS : POLL_DOWN_MS;
}

function schedulePoll() {
  const want = wantedInterval();
  if (want === pollEveryMs) return;
  pollEveryMs = want;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = want ? setInterval(reconcile, want) : null;
}

function syncTransport() {
  if (isDemo()) {
    if (stopStream) {
      stopStream();
      stopStream = null;
    }
    setConn("demo");
    if (!ticker) {
      ticker = setInterval(() => {
        if (s.paused) return;
        queueEvents([nextLiveEvent()]);
        if (s.overview)
          s.overview = {
            ...s.overview,
            events_24h: s.overview.events_24h + 1,
            noise_suppressed_24h: s.overview.noise_suppressed_24h + (Math.random() > 0.5 ? 1 : 0),
          };
      }, 5200);
    }
  } else {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (stopStream) {
      setConn(streamConn);
    } else {
      let stopped = false;
      let inner = null;
      stopStream = () => {
        stopped = true;
        inner?.();
      };
      resolveProject().then((pid) => {
        if (stopped) return;
        inner = connectStream({
          url: streamUrl(pid),
          onState: (c) => {
            streamConn = c;
            setConn(c);
            publish();
          },
          onFrame: handleFrame,
        });
      });
    }
  }
}

// Stop the synthetic stream immediately if an authenticated request rejects the
// session while the store is in demo mode.
subscribeDemo(() => {
  s.demo = isDemo();
  syncTransport();
  publish();
});

/**
 * A frame arrived that invalidates something the store does not hold inline.
 * Debounced, because a burst of frames should cost one reconcile, not twenty.
 * Bumping `rev` lets pages with their own endpoints refetch on the push instead of
 * polling for it.
 */
function scheduleRefresh() {
  s.rev++;
  publish();
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    reconcile();
  }, 600);
}

function handleFrame(name, data) {
  if (name === "heartbeat") return;
  if (name === "event.new" || name === "event.batch") {
    const arr = Array.isArray(data)
      ? data
      : data?.events || data?.items || (data?.id ? [data] : []);
    queueEvents(arr);
    return;
  }
  if (
    (name === "incident.new" || name === "incident.updated" || name === "incident.upserted") &&
    data?.id
  ) {
    const prev = s.incidents.get(data.id) || {};
    s.incidents.set(data.id, { ...prev, ...data });
    reorder();
    publish();
  }
  if (REFRESH_ON.has(name)) scheduleRefresh();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  bootstrap();
  schedulePoll();
  // A hidden tab polls nothing. Coming back into view reconciles at once rather than
  // waiting out the interval, so the analyst never looks at a stale screen.
  document.addEventListener("visibilitychange", () => {
    schedulePoll();
    if (document.visibilityState !== "hidden") reconcile();
  });
}

function subscribe(l) {
  listeners.add(l);
  start();
  return () => listeners.delete(l);
}

export function useStore() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}

export const storeActions = {
  setPaused(v) {
    s.paused = v;
    publish();
  },
  refresh: () => bootstrap(),
  patchIncident(id, patch) {
    const cur = s.incidents.get(id);
    if (cur) {
      s.incidents.set(id, { ...cur, ...patch });
      publish();
    }
  },
};
