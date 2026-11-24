// First-run helpers: the onboarding "safe test hit" and sample-data mode.
// Pure functions plus one polling loop with injectable clock, so node tests cover them.

/** Fired on window after sample data is loaded or cleared, so the shell banner refreshes. */
export const SAMPLE_CHANGED = "lxs:sample-changed";

export function announceSampleChange() {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function")
    window.dispatchEvent(new Event(SAMPLE_CHANGED));
}

/** Incident built from onboarding sample data. */
export const isSampleIncident = (i) => Boolean(i?.sample);

/** Incident built from a test hit (replayed, but not sample data). */
export const isTestIncident = (i) => Boolean(i?.simulated) && !i?.sample;

/** The badge an incident gets for replayed data, or null for a real one. */
export function replayBadge(i) {
  if (isSampleIncident(i))
    return { label: "Sample data", title: "Loaded from onboarding sample data" };
  if (isTestIncident(i)) return { label: "Test", title: "Triggered by the onboarding test hit" };
  return null;
}

/** The incident a test hit from `srcIp` opened, if it exists yet. */
export function findTestIncident(incidents, srcIp) {
  if (!srcIp || !Array.isArray(incidents)) return null;
  return incidents.find((i) => i?.src_ip === srcIp) ?? null;
}

/**
 * Offer sample data only on a project with nothing real in it yet: no real events,
 * no sample data loaded. `status` is GET …/demo/sample-data.
 */
export function shouldOfferSample(status) {
  if (!status || typeof status !== "object") return false;
  return !status.loaded && (status.real_events ?? 0) === 0;
}

/**
 * Progress of a test hit, for the onboarding card:
 *   idle → sending → processing → incident  (or → slow after `slowAfterMs`, still polling)
 */
export function testHitPhase({ sending, sent, incident, elapsedMs = 0, slowAfterMs = 30000 }) {
  if (incident) return "incident";
  if (sending) return "sending";
  if (!sent) return "idle";
  return elapsedMs >= slowAfterMs ? "slow" : "processing";
}

const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Poll the incident list until the test hit's incident appears, `timeoutMs` passes, or
 * `signal` aborts. Resolves to the incident or null. A failed poll is reported through
 * `onTick` and retried: one flaky request must not end the wait.
 */
export async function waitForTestIncident({
  srcIp,
  fetchIncidents,
  intervalMs = 2000,
  timeoutMs = 120000,
  signal,
  onTick,
  sleep = realSleep,
  now = () => Date.now(),
}) {
  const start = now();
  while (!signal?.aborted) {
    let found = null;
    try {
      found = findTestIncident(await fetchIncidents(), srcIp);
      onTick?.({ elapsedMs: now() - start, error: null });
    } catch (error) {
      onTick?.({ elapsedMs: now() - start, error });
    }
    if (found) return found;
    if (now() - start >= timeoutMs) return null;
    await sleep(intervalMs, signal);
  }
  return null;
}
