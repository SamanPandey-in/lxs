import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="auth-screen">
      <header className="auth-nav">
        <Link className="auth-brand" href="/">
          LXS
        </Link>
        <Link className="auth-nav-link" href="/login">
          Log in
        </Link>
      </header>
      <section className="landing-content">
        <span className="auth-eyebrow">LXS · DECEPTION SECURITY</span>
        <h1>See threats before they reach what matters.</h1>
        <p>
          Deploy believable decoys, detect targeted activity, and investigate it from one clear
          dashboard.
        </p>
        <div className="landing-actions">
          <Link className="auth-button auth-button-primary" href="/signup">
            Create account <span aria-hidden>→</span>
          </Link>
          <Link className="auth-button" href="/login">
            Log in
          </Link>
        </div>
      </section>
      <footer className="landing-footer">A focused workspace for your security signals.</footer>
    </main>
  );
}
