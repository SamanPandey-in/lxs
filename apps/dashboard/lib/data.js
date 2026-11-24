// Data-handling API helpers: retention summary, project export, project delete/restore
// and account delete. Same request/IdentityError plumbing as lib/identity.js: these are
// owner actions that must never fall back to mock data.
import { getApiUrl } from "./config";
import { request } from "./identity";

const e = encodeURIComponent;

export const dataApi = {
  summary: (pid) => request(`/v1/projects/${e(pid)}/data`),
  exports: (pid) => request(`/v1/projects/${e(pid)}/exports`),
  requestExport: (pid) => request(`/v1/projects/${e(pid)}/export`, { method: "POST", body: {} }),
  deleteProject: (pid, confirm) =>
    request(`/v1/projects/${e(pid)}`, { method: "DELETE", body: { confirm } }),
  restoreProject: (pid) => request(`/v1/projects/${e(pid)}/restore`, { method: "POST", body: {} }),
  deletedProjects: (orgId) => request(`/v1/orgs/${e(orgId)}/deleted-projects`),
  deleteAccount: (password) => request("/v1/me", { method: "DELETE", body: { password } }),
};

/** Absolute URL for an API path the browser should open directly (a download). */
export const apiHref = (path) => `${getApiUrl()}${path}`;

/** "1.4 MB" style sizes; "—" when unknown. */
export function formatBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x >= 10 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

/**
 * How to show the password half of a captured credential. Older events have their
 * password replaced by a peppered hash (API: worker/maintenance.ts), so show "hashed"
 * rather than a blank or "undefined".
 */
export function passwordText(fields) {
  const f = fields || {};
  if (f.password_masked) return f.password_masked;
  if (f.password_hash) return "(hashed)";
  return "•••";
}

/** "root / a***n" for an auth event's fields. */
export const credentialText = (fields) => `${fields?.username || "?"} / ${passwordText(fields)}`;
