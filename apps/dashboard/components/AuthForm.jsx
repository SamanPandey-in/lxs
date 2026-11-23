"use client";
import { ArrowLeft, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Captcha, useCaptchaConfig } from "@/components/captcha";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { loadConfig } from "@/lib/config";
import { coreUrl, setActiveProject } from "@/lib/core";
import { safeNext } from "@/lib/identity";

export const AUTH_FOOTER = "Email links are single-use and expire quickly.";

export const focusRing =
  "rounded-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Template E frame shared by the landing page, /login and /signup: one 1080 px container,
 * so the logo, the content and the footer share one left edge.
 */
export function PublicShell({ nav, footer, children }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1080px] min-w-0 flex-1 flex-col px-6">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4">
          <Link href="/" className={`text-lg font-semibold text-foreground ${focusRing}`}>
            LXS
          </Link>
          {nav}
        </header>
        <main id="main" className="flex min-w-0 flex-1 flex-col">
          {children}
        </main>
        <footer className="shrink-0 border-t border-border py-4 text-sm text-muted-foreground">
          {footer}
        </footer>
      </div>
    </div>
  );
}

// Field messages, by input name. Shown on blur and on submit, never while typing (patterns.md §6).
function messageFor(el, signup) {
  const v = el.validity;
  if (!v || v.valid) return "";
  switch (el.name) {
    case "project_name":
      return "Enter a name for your first project.";
    case "username":
      if (!signup) return "Enter your username or email.";
      if (v.valueMissing) return "Choose a username.";
      return "Use 3–32 characters: a letter first, then letters, numbers, _ or -.";
    case "email":
      return v.valueMissing ? "Enter your email address." : "Enter a valid email address.";
    case "password":
      if (v.valueMissing) return "Enter your password.";
      return "Use at least 8 characters.";
    default:
      return el.validationMessage;
  }
}

/** Label above (optional `aside` link on the right), 40 px input, error (or hint) under it. */
export function AuthField({ id, label, error, hint, onBlur, aside, ...input }) {
  const msgId = `${id}-msg`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {aside}
      </div>
      <Input
        id={id}
        className="h-10"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? msgId : undefined}
        onBlur={onBlur}
        {...input}
      />
      {error ? (
        <p id={msgId} className="m-0 text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="m-0 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Form({ signup }) {
  const router = useRouter();
  const params = useSearchParams();
  // Signup-then-accept: /signup?invite=<token>&email=<address> joins the inviting org.
  const inviteToken = signup ? params.get("invite") || "" : "";
  const captchaConfig = useCaptchaConfig();
  const [captchaToken, setCaptchaToken] = useState("");
  const [identifier, setIdentifier] = useState(() => (signup && params.get("email")) || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [projectName, setProjectName] = useState("My first project");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const validateField = (e) => {
    const el = e.target;
    setErrors((cur) => ({ ...cur, [el.name]: messageFor(el, signup) }));
  };
  // Clear a field's error as soon as it becomes valid; don't add new ones while typing.
  const change = (setter) => (e) => {
    setter(e.target.value);
    const el = e.target;
    if (errors[el.name] && el.validity?.valid) setErrors((cur) => ({ ...cur, [el.name]: "" }));
  };

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const next = {};
    let first = null;
    for (const el of form.elements) {
      if (!el.name || el.tagName !== "INPUT") continue;
      const msg = messageFor(el, signup);
      next[el.name] = msg;
      if (msg && !first) first = el;
    }
    setErrors(next);
    setFormError("");
    if (first) {
      first.focus();
      return;
    }
    if (signup && captchaConfig.provider !== "none" && !captchaToken) {
      setFormError("Complete the bot check first.");
      return;
    }
    setBusy(true);
    try {
      // Runtime config first: until it loads, coreUrl() is only the build-time default.
      await loadConfig();
      const response = await fetch(`${coreUrl()}/v1/auth/${signup ? "signup" : "login"}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(
          signup
            ? {
                email: identifier,
                username: username || undefined,
                password,
                name,
                project_name: inviteToken ? undefined : projectName,
                invite_token: inviteToken || undefined,
                captcha_token: captchaToken || undefined,
              }
            : { identifier, password },
        ),
      });
      const data = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          data?.error?.message ||
            data?.message ||
            (response.status === 401
              ? "That username or password isn't right. Check both and try again."
              : `The server answered ${response.status}. Try again in a moment.`),
        );
      if (signup && data?.project?.id) setActiveProject(data.project.id);
      router.replace(safeNext(params.get("next"), inviteToken ? "/dashboard" : "/onboarding"));
    } catch (err) {
      setFormError(err.message || "Couldn't reach the API. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <PublicShell
      nav={
        <Button
          variant="ghost"
          render={<Link href={signup ? "/login" : "/signup"} />}
          nativeButton={false}
        >
          {signup ? "Log in" : "Create account"}
        </Button>
      }
      footer={AUTH_FOOTER}
    >
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-4 py-10 sm:my-auto">
        <Link
          href="/"
          className={`inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground ${focusRing}`}
        >
          <ArrowLeft className="size-4" aria-hidden /> Back to home
        </Link>
        <section
          aria-labelledby="auth-title"
          className="flex flex-col gap-6 rounded-lg border border-border bg-card p-6"
        >
          <div className="flex flex-col gap-1">
            <h1 id="auth-title" className="m-0 text-2xl font-semibold tracking-[-0.01em]">
              {signup ? "Create your account" : "Log in to LXS"}
            </h1>
            <p className="m-0 text-sm text-muted-foreground">
              {signup
                ? inviteToken
                  ? "Create an account with the invited address to join the team."
                  : "Start monitoring your decoys and security signals."
                : "Enter your account details to continue."}
            </p>
          </div>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            {signup && (
              <AuthField
                id="name"
                name="name"
                label="Name"
                autoComplete="name"
                value={name}
                onChange={change(setName)}
                onBlur={validateField}
                maxLength={128}
                error={errors.name}
              />
            )}
            {signup && !inviteToken && (
              <AuthField
                id="project_name"
                name="project_name"
                label="First project"
                autoComplete="off"
                required
                value={projectName}
                onChange={change(setProjectName)}
                onBlur={validateField}
                minLength={1}
                maxLength={128}
                error={errors.project_name}
              />
            )}
            {signup && (
              <AuthField
                id="username"
                name="username"
                label="Username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={username}
                onChange={change(setUsername)}
                onBlur={validateField}
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z][A-Za-z0-9_\-]*"
                hint="3–32 characters: a letter first, then letters, numbers, _ or -."
                error={errors.username}
              />
            )}
            <AuthField
              id={signup ? "email" : "identifier"}
              name={signup ? "email" : "username"}
              label={signup ? "Email" : "Username or email"}
              type={signup ? "email" : "text"}
              inputMode={signup ? "email" : undefined}
              autoComplete={signup ? "email" : "username"}
              autoCapitalize="none"
              spellCheck={false}
              required
              value={identifier}
              onChange={change(setIdentifier)}
              onBlur={validateField}
              error={signup ? errors.email : errors.username}
            />
            <AuthField
              id="password"
              name="password"
              label="Password"
              type="password"
              autoComplete={signup ? "new-password" : "current-password"}
              required
              minLength={signup ? 8 : undefined}
              value={password}
              onChange={change(setPassword)}
              onBlur={validateField}
              hint={signup ? "At least 8 characters." : undefined}
              error={errors.password}
              aside={
                signup ? null : (
                  <Link
                    href="/forgot-password"
                    className={`text-xs font-medium text-link hover:underline ${focusRing}`}
                  >
                    Forgot password?
                  </Link>
                )
              }
            />
            {signup ? <Captcha config={captchaConfig} onToken={setCaptchaToken} /> : null}
            {formError ? (
              <p role="alert" className="m-0 flex items-start gap-2 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 [overflow-wrap:anywhere]">{formError}</span>
              </p>
            ) : null}
            <Button type="submit" size="lg" className="h-10 w-full" loading={busy}>
              {signup ? "Create account" : "Log in"}
            </Button>
          </form>
          <p className="m-0 text-center text-sm text-muted-foreground">
            {signup ? "Already have an account?" : "New to LXS?"}{" "}
            <Link
              href={signup ? "/login" : "/signup"}
              className={`font-medium text-link hover:underline ${focusRing}`}
            >
              {signup ? "Log in" : "Create an account"}
            </Link>
          </p>
        </section>
      </div>
    </PublicShell>
  );
}

function FormSkeleton() {
  return (
    <PublicShell footer={AUTH_FOOTER}>
      <div
        role="status"
        aria-live="polite"
        className="mx-auto flex w-full max-w-[400px] flex-col gap-4 py-10 sm:my-auto"
      >
        <span className="sr-only">Loading</span>
        <Skeleton className="h-5 w-28" />
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="mt-2 h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </PublicShell>
  );
}

export default function AuthForm(props) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <Form {...props} />
    </Suspense>
  );
}
