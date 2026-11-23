// Identity API helpers: verification, password reset, invites and members.
//
// Kept apart from lib/core.js on purpose: these are auth-flow calls (some public,
// some for pages outside the shell), they never fall back to mock data, and every
// failure is an IdentityError carrying the API's error code so pages can explain it.
import { useEffect, useSyncExternalStore } from "react";
import { getApiUrl, loadConfig } from "./config";

export class IdentityError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const e = encodeURIComponent;

/** One JSON request. Throws IdentityError on any non-2xx or network failure. */
export async function request(path, { method = "GET", body } = {}) {
  await loadConfig();
  let res;
  try {
    res = await fetch(`${getApiUrl()}${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers:
        body !== undefined
          ? { "Content-Type": "application/json", Accept: "application/json" }
          : { Accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new IdentityError(
      `Couldn't reach the API at ${getApiUrl()}. Check your connection and try again.`,
      0,
      "network",
    );
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data?.error;
    throw new IdentityError(
      err?.message || `The server answered ${res.status}. Try again in a moment.`,
      res.status,
      err?.code || "http_error",
      err?.details,
    );
  }
  return data;
}

export const identity = {
  authConfig: () => request("/v1/auth/config"),
  verifyEmail: (token) => request("/v1/auth/verify-email", { method: "POST", body: { token } }),
  resendVerification: () => request("/v1/auth/verify-email/resend", { method: "POST", body: {} }),
  forgotPassword: (email, captchaToken) =>
    request("/v1/auth/password/forgot", {
      method: "POST",
      body: { email, captcha_token: captchaToken || undefined },
    }),
  resetPassword: (token, password) =>
    request("/v1/auth/password/reset", { method: "POST", body: { token, password } }),
  invitePreview: (token) => request("/v1/invites/preview", { method: "POST", body: { token } }),
  acceptInvite: (token) => request("/v1/invites/accept", { method: "POST", body: { token } }),
  project: (pid) => request(`/v1/projects/${e(pid)}`),
  members: (orgId) => request(`/v1/orgs/${e(orgId)}/members`),
  invite: (orgId, email, role) =>
    request(`/v1/orgs/${e(orgId)}/invites`, { method: "POST", body: { email, role } }),
  revokeInvite: (orgId, inviteId) =>
    request(`/v1/orgs/${e(orgId)}/invites/${e(inviteId)}`, { method: "DELETE" }),
  changeRole: (orgId, userId, role) =>
    request(`/v1/orgs/${e(orgId)}/members/${e(userId)}`, { method: "PATCH", body: { role } }),
  removeMember: (orgId, userId) =>
    request(`/v1/orgs/${e(orgId)}/members/${e(userId)}`, { method: "DELETE" }),
};

/** A `next` value is only followed when it is a same-site path. */
export const safeNext = (next, fallback = "/onboarding") =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : fallback;

/* ───────── the signed-in user (external store, fetched once) ───────── */

let me = null; // { user, orgs } | null
let mePromise = null;
const meSubs = new Set();
const publish = () => {
  for (const f of meSubs) f();
};

/** GET /v1/me once per page load; `force` refetches (after verifying, say). */
export function loadMe(force = false) {
  if (mePromise && !force) return mePromise;
  mePromise = request("/v1/me")
    .then((body) => {
      me = body;
      publish();
      return body;
    })
    .catch((err) => {
      mePromise = null; // retry on the next call
      throw err;
    });
  return mePromise;
}

/** Seed the store from a /v1/me body the caller already has (the shell's session check). */
export function setMe(body) {
  me = body ?? null;
  if (me) mePromise = Promise.resolve(me);
  publish();
}

export const getMe = () => me;

/** The signed-in user ({ id, email, email_verified, ... }) or null while unknown. */
export function useMe() {
  const snapshot = useSyncExternalStore(
    (fn) => {
      meSubs.add(fn);
      return () => meSubs.delete(fn);
    },
    () => me,
    () => null,
  );
  useEffect(() => {
    if (!me) loadMe().catch(() => {});
  }, []);
  return snapshot?.user ?? null;
}

export const ROLE_LABELS = { owner: "Owner", analyst: "Analyst", viewer: "Viewer" };
export const ROLE_HELP = {
  owner: "Everything, including keys, settings, members and alert channels.",
  analyst: "Reads everything and works incidents: notes, status, blocking.",
  viewer: "Read only.",
};
