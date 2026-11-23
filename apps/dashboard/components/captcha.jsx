"use client";
import { useEffect, useRef, useState } from "react";
import { identity } from "@/lib/identity";

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise = null;

function loadTurnstile() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("The bot check couldn't load. Check your connection and reload."));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** The API's captcha settings ({ provider, site_key }), fetched once per page. */
export function useCaptchaConfig() {
  const [cfg, setCfg] = useState({ provider: "none", site_key: null, loaded: false });
  useEffect(() => {
    let active = true;
    identity
      .authConfig()
      .then((r) => active && setCfg({ ...(r?.captcha ?? { provider: "none" }), loaded: true }))
      .catch(() => active && setCfg({ provider: "none", site_key: null, loaded: true }));
    return () => {
      active = false;
    };
  }, []);
  return cfg;
}

/**
 * Renders the provider's widget when the API has one switched on (CAPTCHA_PROVIDER),
 * and nothing otherwise. `onToken` receives the token, or "" when it expires.
 */
export function Captcha({ config, onToken }) {
  const ref = useRef(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const [error, setError] = useState("");
  const on = config?.provider === "turnstile" && config.site_key;

  useEffect(() => {
    if (!on || !ref.current) return;
    let widget = null;
    let cancelled = false;
    loadTurnstile()
      .then((ts) => {
        if (cancelled || !ref.current) return;
        widget = ts.render(ref.current, {
          sitekey: config.site_key,
          callback: (t) => cb.current?.(t),
          "expired-callback": () => cb.current?.(""),
          "error-callback": () => cb.current?.(""),
        });
      })
      .catch((err) => setError(err.message));
    return () => {
      cancelled = true;
      if (widget != null) window.turnstile?.remove?.(widget);
    };
  }, [on, config?.site_key]);

  if (!on) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div ref={ref} />
      {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
