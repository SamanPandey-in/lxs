"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { loadConfig } from "@/lib/config";
import { coreUrl, setActiveProject } from "@/lib/core";

function Form({ signup }) {
  const router = useRouter();
  const params = useSearchParams();
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [projectName, setProjectName] = useState("My First Project");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
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
                project_name: projectName,
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
              ? "Invalid email or password."
              : `Request failed (${response.status}).`),
        );
      if (signup && data?.project?.id) setActiveProject(data.project.id);
      const next = params.get("next");
      router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/onboarding");
    } catch (err) {
      setError(err.message || "Could not reach the API. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <header className="auth-nav">
        <Link className="auth-brand" href="/">
          LXS
        </Link>
        <Link className="auth-nav-link" href={signup ? "/login" : "/signup"}>
          {signup ? "Log in" : "Create account"}
        </Link>
      </header>
      <section className="auth-card">
        <Link className="auth-back" href="/">
          ← Back to home
        </Link>
        <span className="auth-eyebrow">{signup ? "GET STARTED" : "WELCOME BACK"}</span>
        <h1>{signup ? "Create your account" : "Log in to LXS"}</h1>
        <p className="auth-description">
          {signup
            ? "Start monitoring your decoys and security signals."
            : "Enter your account details to continue."}
        </p>
        <form className="auth-form" onSubmit={submit}>
          {signup && (
            <label className="auth-field">
              Name{" "}
              <input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={128}
              />
            </label>
          )}
          {signup && (
            <label className="auth-field">
              First project
              <input
                required
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                minLength={1}
                maxLength={128}
              />
            </label>
          )}
          {signup && (
            <label className="auth-field">
              Username
              <input
                required
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z][A-Za-z0-9_-]*"
              />
            </label>
          )}
          <label className="auth-field">
            {signup ? "Email" : "Username or email"}
            <input
              required
              type={signup ? "email" : "text"}
              autoComplete={signup ? "email" : "username"}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </label>
          <label className="auth-field">
            Password
            <input
              required
              type="password"
              autoComplete={signup ? "new-password" : "current-password"}
              minLength={signup ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="auth-button auth-button-primary auth-submit"
            disabled={busy}
          >
            {busy ? "Please wait…" : signup ? "Create account" : "Log in"}
          </button>
        </form>
        <p className="auth-switch">
          {signup ? "Already have an account?" : "New to LXS?"}{" "}
          <Link href={signup ? "/login" : "/signup"}>{signup ? "Log in" : "Sign up"}</Link>
        </p>
      </section>
      <footer className="landing-footer">
        No email verification is required for this prototype.
      </footer>
    </main>
  );
}

export default function AuthForm(props) {
  return (
    <Suspense
      fallback={
        <main className="auth-screen">
          <p>Loading…</p>
        </main>
      }
    >
      <Form {...props} />
    </Suspense>
  );
}
