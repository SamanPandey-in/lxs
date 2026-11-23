"use client";
import { ArrowLeft, CircleAlert, CircleCheck, MailCheck } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AUTH_FOOTER, AuthField, focusRing, PublicShell } from "@/components/AuthForm";
import { Captcha, useCaptchaConfig } from "@/components/captcha";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { identity, ROLE_LABELS, request } from "@/lib/identity";

/*
 * Public account pages: /forgot-password, /reset-password, /verify-email and
 * /invite/[token]. Same frame and card as /login and /signup (AuthForm).
 */

function LoginNav() {
  return (
    <Button variant="ghost" render={<Link href="/login" />} nativeButton={false}>
      Log in
    </Button>
  );
}

function AuthCard({ title, description, children, back = true }) {
  return (
    <PublicShell nav={<LoginNav />} footer={AUTH_FOOTER}>
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-4 py-10 sm:my-auto">
        {back ? (
          <Link
            href="/login"
            className={`inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground ${focusRing}`}
          >
            <ArrowLeft className="size-4" aria-hidden /> Back to log in
          </Link>
        ) : null}
        <section
          aria-labelledby="auth-title"
          className="flex flex-col gap-6 rounded-lg border border-border bg-card p-6"
        >
          <div className="flex flex-col gap-1">
            <h1 id="auth-title" className="m-0 text-2xl font-semibold tracking-[-0.01em]">
              {title}
            </h1>
            {description ? (
              <p className="m-0 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {children}
        </section>
      </div>
    </PublicShell>
  );
}

function FormError({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="m-0 flex items-start gap-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

function Notice({ icon: Icon = CircleCheck, children }) {
  return (
    <p role="status" className="m-0 flex items-start gap-2 text-sm text-foreground">
      <Icon className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

function CardSkeleton() {
  return (
    <PublicShell footer={AUTH_FOOTER}>
      <div
        role="status"
        aria-live="polite"
        className="mx-auto flex w-full max-w-[400px] flex-col gap-4 py-10 sm:my-auto"
      >
        <span className="sr-only">Loading</span>
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="mt-2 h-10 w-full" />
        </div>
      </div>
    </PublicShell>
  );
}

const withSuspense = (Component) =>
  function Suspended(props) {
    return (
      <Suspense fallback={<CardSkeleton />}>
        <Component {...props} />
      </Suspense>
    );
  };

/* ───────────────────────────── forgot ───────────────────────────── */

function Forgot() {
  const captchaConfig = useCaptchaConfig();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = (el) =>
    el.validity.valid
      ? ""
      : el.validity.valueMissing
        ? "Enter your email address."
        : "Enter a valid email address.";

  async function submit(event) {
    event.preventDefault();
    const el = event.currentTarget.elements.email;
    const msg = check(el);
    setFieldError(msg);
    setError("");
    if (msg) return el.focus();
    if (captchaConfig.provider !== "none" && !captchaToken)
      return setError("Complete the bot check first.");
    setBusy(true);
    try {
      await identity.forgotPassword(email.trim(), captchaToken);
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email address on your account and we'll send a reset link."
    >
      {sent ? (
        <div className="flex flex-col gap-4">
          <Notice icon={MailCheck}>
            If an account uses {email.trim()}, a reset link is on its way. It works once and expires
            in 30 minutes.
          </Notice>
          <Button variant="outline" className="h-10 w-full" onClick={() => setSent(false)}>
            Use a different address
          </Button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <AuthField
            id="email"
            name="email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldError && e.target.validity.valid) setFieldError("");
            }}
            onBlur={(e) => setFieldError(check(e.target))}
            error={fieldError}
          />
          <Captcha config={captchaConfig} onToken={setCaptchaToken} />
          <FormError>{error}</FormError>
          <Button type="submit" size="lg" className="h-10 w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
export const ForgotPasswordPage = withSuspense(Forgot);

/* ───────────────────────────── reset ───────────────────────────── */

function Reset() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const validate = () => {
    const next = {};
    if (password.length < 8) next.password = "Use at least 8 characters.";
    if (confirm !== password) next.confirm = "The two passwords don't match.";
    setErrors(next);
    return next;
  };

  async function submit(event) {
    event.preventDefault();
    setError("");
    const next = validate();
    if (next.password || next.confirm) {
      event.currentTarget.elements[next.password ? "password" : "confirm"]?.focus();
      return;
    }
    setBusy(true);
    try {
      await identity.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!token)
    return (
      <AuthCard title="This reset link is incomplete">
        <FormError>
          The link has no token. Open it again from the email, or request a new one.
        </FormError>
        <Button
          render={<Link href="/forgot-password" />}
          nativeButton={false}
          className="h-10 w-full"
        >
          Request a new link
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard
      title={done ? "Password changed" : "Choose a new password"}
      description={done ? null : "Every other signed-in session will be signed out."}
    >
      {done ? (
        <div className="flex flex-col gap-4">
          <Notice>Your password is updated and your other sessions are signed out.</Notice>
          <Button
            render={<Link href="/login" />}
            nativeButton={false}
            size="lg"
            className="h-10 w-full"
          >
            Log in
          </Button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <input type="hidden" name="username" autoComplete="username" />
          <AuthField
            id="password"
            name="password"
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 8 characters."
            error={errors.password}
          />
          <AuthField
            id="confirm"
            name="confirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={errors.confirm}
          />
          <FormError>
            {error}
            {error ? (
              <>
                {" "}
                <Link
                  href="/forgot-password"
                  className={`font-medium text-link hover:underline ${focusRing}`}
                >
                  Request a new link
                </Link>
              </>
            ) : null}
          </FormError>
          <Button type="submit" size="lg" className="h-10 w-full" loading={busy}>
            Set new password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
export const ResetPasswordPage = withSuspense(Reset);

/* ───────────────────────────── verify ───────────────────────────── */

function Verify() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [state, setState] = useState({ status: "idle", email: "", error: "" });

  // A click, not an automatic request: link scanners that prefetch the page must
  // not burn the single-use token.
  const confirm = async () => {
    setState({ status: "busy", email: "", error: "" });
    try {
      const r = await identity.verifyEmail(token);
      setState({ status: "done", email: r?.email || "", error: "" });
    } catch (err) {
      setState({ status: "error", email: "", error: err.message });
    }
  };

  if (!token)
    return (
      <AuthCard title="This verification link is incomplete">
        <FormError>
          The link has no token. Open it again from the email, or sign in and resend it from the
          banner.
        </FormError>
      </AuthCard>
    );

  if (state.status === "done")
    return (
      <AuthCard title="Email confirmed" back={false}>
        <Notice>
          {state.email ? `${state.email} is confirmed.` : "Your address is confirmed."} You can now
          create ingest keys and invite your team.
        </Notice>
        <Button
          render={<Link href="/dashboard" />}
          nativeButton={false}
          size="lg"
          className="h-10 w-full"
        >
          Go to the dashboard
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard title="Confirm your email" description="One click and your account is fully set up.">
      <div className="flex flex-col gap-4">
        <FormError>{state.error}</FormError>
        <Button
          size="lg"
          className="h-10 w-full"
          onClick={confirm}
          loading={state.status === "busy"}
        >
          Confirm my email
        </Button>
        {state.status === "error" ? (
          <p className="m-0 text-sm text-muted-foreground">
            Signed in already? Resend a fresh link from the banner at the top of the dashboard.
          </p>
        ) : null}
      </div>
    </AuthCard>
  );
}
export const VerifyEmailPage = withSuspense(Verify);

/* ───────────────────────────── invite ───────────────────────────── */

const STATUS_COPY = {
  accepted: "This invitation has already been used.",
  revoked: "This invitation was withdrawn.",
  expired: "This invitation has expired.",
};

export function InvitePage({ token }) {
  const router = useRouter();
  const [preview, setPreview] = useState(null);
  const [me, setMeState] = useState(undefined); // undefined = checking, null = signed out
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    identity
      .invitePreview(token)
      .then((p) => active && setPreview(p))
      .catch(
        (err) =>
          active &&
          setError(
            err.status === 404
              ? "This invitation link isn't valid. Ask for a new one."
              : err.message,
          ),
      );
    fetchMe().then((u) => active && setMeState(u));
    return () => {
      active = false;
    };
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      await identity.acceptInvite(token);
      router.replace("/dashboard");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const here = `/invite/${encodeURIComponent(token)}`;
  if (!preview && !error) return <CardSkeleton />;
  if (!preview)
    return (
      <AuthCard title="Invitation not found">
        <FormError>{error}</FormError>
      </AuthCard>
    );

  const role = ROLE_LABELS[preview.role] || preview.role;
  const pending = preview.status === "pending";
  const sameUser = me && me.email?.toLowerCase() === preview.email?.toLowerCase();
  return (
    <AuthCard
      title={`Join ${preview.org_name}`}
      description={`You're invited as ${/^[AEIOU]/.test(role) ? "an" : "a"} ${role.toLowerCase()}. The invitation is for ${preview.email}.`}
      back={false}
    >
      <div className="flex flex-col gap-4">
        {!pending ? (
          <FormError>{STATUS_COPY[preview.status] || "This invitation can't be used."}</FormError>
        ) : null}
        <FormError>{pending ? error : ""}</FormError>
        {!pending ? null : me === undefined ? (
          <Skeleton className="h-10 w-full" />
        ) : sameUser ? (
          <Button size="lg" className="h-10 w-full" onClick={accept} loading={busy}>
            Accept and join
          </Button>
        ) : me ? (
          <>
            <p className="m-0 text-sm text-muted-foreground">
              You're signed in as {me.email}. Log out, then sign in or create an account with{" "}
              {preview.email} to accept.
            </p>
            <Button
              variant="outline"
              size="lg"
              className="h-10 w-full"
              render={<Link href={`/login?next=${encodeURIComponent(here)}`} />}
              nativeButton={false}
            >
              Switch account
            </Button>
          </>
        ) : (
          <>
            <Button
              size="lg"
              className="h-10 w-full"
              render={
                <Link
                  href={`/signup?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(preview.email)}`}
                />
              }
              nativeButton={false}
            >
              Create account and join
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-10 w-full"
              render={<Link href={`/login?next=${encodeURIComponent(here)}`} />}
              nativeButton={false}
            >
              I already have an account
            </Button>
          </>
        )}
      </div>
    </AuthCard>
  );
}

/** The signed-in user, or null. Never throws. */
async function fetchMe() {
  try {
    const body = await request("/v1/me");
    return body?.user ?? null;
  } catch {
    return null;
  }
}
