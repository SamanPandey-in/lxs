// EventSource client for GET /v1/stream?project=:pid with exponential-backoff reconnect (cap 8 s).
export const FRAME_NAMES = [
  // api.ts StreamEventName
  "event.new",
  "incident.new",
  "incident.updated",
  "incident.ai",
  "sensor.status",
  "action.applied",
  "heartbeat",
  // names used by docs/06-backend.md §8.8
  "event.batch",
  "incident.upserted",
  "incident.ai_ready",
  "action.updated",
  "decoy.health",
  "onboarding.updated",
  "reset",
];

export function connectStream({ url, onFrame, onState }) {
  let es = null;
  let closed = false;
  let attempt = 0;
  let timer = null;

  const open = () => {
    if (closed) return;
    onState?.(attempt === 0 ? "connecting" : "reconnecting");
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      schedule();
      return;
    }
    es.onopen = () => {
      attempt = 0;
      onState?.("live");
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      onState?.("reconnecting");
      schedule();
    };
    const handle = (name) => (ev) => {
      let data = ev.data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        /* keep raw */
      }
      onFrame?.(name, data, ev.lastEventId);
    };
    FRAME_NAMES.forEach((n) => es.addEventListener(n, handle(n)));
    // Default `message` frames carry { type, ... } (simplest server mode)
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        onFrame?.(d.type || "message", d, ev.lastEventId);
      } catch {
        /* ignore */
      }
    };
  };

  const schedule = () => {
    const delay = Math.min(8000, 500 * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(open, delay);
  };

  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    es?.close();
  };
}
