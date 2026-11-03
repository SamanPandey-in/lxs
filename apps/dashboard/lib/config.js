// Runtime config, fetched once from /api/config on boot.
//
// The build-time NEXT_PUBLIC_* values are kept only as the pre-boot default, so the
// very first render has something sane to point at. Once loadConfig() resolves, the
// values the server actually has at runtime win. That is what lets one production
// build run against any API host.

const BUILD_DEFAULT_API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const BUILD_DEFAULT_PROJECT = process.env.NEXT_PUBLIC_PROJECT_ID || null;

let apiUrl = BUILD_DEFAULT_API;
let projectId = BUILD_DEFAULT_PROJECT;
let loaded = null;

export const getApiUrl = () => apiUrl;
export const getConfiguredProject = () => projectId;

/**
 * Load runtime config. Safe to call repeatedly — the fetch happens once.
 * Never rejects: if /api/config is unreachable we keep the build-time defaults,
 * which is exactly the old behaviour.
 */
export function loadConfig() {
  if (loaded) return loaded;
  if (typeof window === "undefined") return Promise.resolve({ apiUrl, projectId });
  loaded = fetch("/api/config", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (cfg?.apiUrl) apiUrl = cfg.apiUrl;
      if (cfg?.projectId) projectId = cfg.projectId;
      return { apiUrl, projectId };
    })
    .catch(() => ({ apiUrl, projectId }));
  return loaded;
}
