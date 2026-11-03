'use client';

import { useEffect, useRef, useState } from 'react';

const API = '/api/attacker';

// Inline theme object, Genesis-demo-client style (attackerFRONTEND.md §2).
const C = {
  bg: '#0b0d0e',
  panel: '#0f1113',
  border: '#2a2f2f',
  text: '#c9f7c9',
  dim: '#6b8f6b',
  amber: '#ffb000',
  red: '#ff4d4d',
  green: '#39ff6a',
};

function Banner({ text }) {
  return (
    <div
      style={{
        background: C.red,
        color: '#1a0000',
        fontWeight: 800,
        fontSize: 18,
        padding: '10px 14px',
        borderRadius: 4,
        marginTop: 8,
        textAlign: 'center',
        letterSpacing: 0.5,
      }}
    >
      {text}
    </div>
  );
}

function statusColor(status, blocked) {
  if (blocked || status === 'blocked' || status === 'refused') return C.red;
  if (status === 'error' || status === 'fail') return C.red;
  if (status === 'ok') return C.green;
  return C.dim;
}

export default function Page() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(false);
  const [mode, setMode] = useState('live'); // 'live' | 'safe'
  const [scenarios, setScenarios] = useState([]);
  const [running, setRunning] = useState(null); // scenario id currently running
  const [steps, setSteps] = useState([]);
  const [doneInfo, setDoneInfo] = useState(null);
  const abortRef = useRef(null);

  // Web console state
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('/admin');
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [httpResult, setHttpResult] = useState(null);

  // SSH console state
  const [sshUser, setSshUser] = useState('admin');
  const [sshPass, setSshPass] = useState('admin');
  const [cmd, setCmd] = useState('ls -la');
  const [sessionId, setSessionId] = useState(null);
  const [sshResult, setSshResult] = useState(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await fetch(`${API}/health`, { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setHealth(j);
        setHealthError(false);
      } catch {
        if (!alive) return;
        setHealthError(true);
      }
    }
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    fetch(`${API}/scenarios`)
      .then((r) => r.json())
      .then(setScenarios)
      .catch(() => setScenarios([]));
  }, []);

  async function runScenario(id) {
    setRunning(id);
    setSteps([]);
    setDoneInfo(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`${API}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: id, mode }),
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.type === 'step') {
            setSteps((prev) => [...prev, frame]);
          } else if (frame.type === 'done') {
            setDoneInfo(frame);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setSteps((prev) => [
          ...prev,
          { kind: 'error', label: 'run', status: 'error', detail: err.message },
        ]);
      }
    } finally {
      setRunning(null);
    }
  }

  function stopOrReset() {
    if (running && abortRef.current) {
      abortRef.current.abort();
      setRunning(null);
      return;
    }
    fetch(`${API}/reset`, { method: 'POST' }).catch(() => {});
    setSteps([]);
    setDoneInfo(null);
    setHttpResult(null);
    setSshResult(null);
    setSessionId(null);
  }

  async function sendHttp() {
    const headerObj = headerName && headerValue ? { [headerName]: headerValue } : undefined;
    try {
      const r = await fetch(`${API}/http`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, path, headers: headerObj }),
      });
      const out = await r.json();
      setHttpResult(out);
    } catch (err) {
      setHttpResult({
        status: 0,
        blocked: false,
        isDecoy: false,
        body: '',
        note: `request failed: ${err.message}`,
      });
    }
  }

  async function sshConnectAndMaybeRun(doRun) {
    try {
      const r = await fetch(`${API}/ssh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'login', username: sshUser, password: sshPass, sessionId }),
      });
      const out = await r.json();
      setSessionId(out.sessionId || null);
      setSshResult(out);
      if (doRun && out.ok && !out.refused) {
        await sshRunCommand(out.sessionId);
      }
    } catch (err) {
      setSshResult({
        ok: false,
        refused: false,
        output: `request failed: ${err.message}`,
        action: 'login',
      });
    }
  }

  async function sshRunCommand(sid) {
    try {
      const r = await fetch(`${API}/ssh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'command', cmd, sessionId: sid ?? sessionId }),
      });
      const out = await r.json();
      setSessionId(out.sessionId || sid || sessionId);
      setSshResult(out);
    } catch (err) {
      setSshResult({
        ok: false,
        refused: false,
        output: `request failed: ${err.message}`,
        action: 'command',
      });
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: 16 }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 14 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 800, color: C.amber }}>⚡ ATTACKER CONSOLE</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ color: C.dim }}>mode:</span>
            <button
              type="button"
              onClick={() => setMode('live')}
              style={{
                background: mode === 'live' ? C.green : 'transparent',
                color: mode === 'live' ? '#042604' : C.text,
                border: `1px solid ${C.border}`,
                padding: '4px 10px',
                borderRadius: 3,
                fontWeight: 700,
              }}
            >
              ● LIVE
            </button>
            <button
              type="button"
              onClick={() => setMode('safe')}
              style={{
                background: mode === 'safe' ? C.amber : 'transparent',
                color: mode === 'safe' ? '#2a1a00' : C.text,
                border: `1px solid ${C.border}`,
                padding: '4px 10px',
                borderRadius: 3,
                fontWeight: 700,
              }}
            >
              SAFE
            </button>
          </div>
        </div>
        <div style={{ color: C.dim, marginTop: 6, fontSize: 13 }}>
          target: {health?.targets?.app || '…'} · ssh: {health?.targets?.ssh || '…'} · api mode:{' '}
          {health?.mode || '?'}
        </div>
        {healthError && (
          <div style={{ color: C.red, marginTop: 6, fontSize: 13 }}>
            ⚠ attacker-api offline — start it on :6060 ({API})
          </div>
        )}
        {mode === 'safe' && (
          <div style={{ color: C.amber, marginTop: 6, fontSize: 13, fontWeight: 700 }}>
            SAFE (replay) — using the platform's recorded replay, no live network dependency
          </div>
        )}
      </div>

      {/* Region 1: Scenarios */}
      <section style={{ marginBottom: 18 }}>
        <div style={{ color: C.dim, letterSpacing: 1, marginBottom: 8 }}>SCENARIOS</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {scenarios.map((s) => (
            <button
              type="button"
              key={s.id}
              disabled={!!running || healthError}
              onClick={() => runScenario(s.id)}
              title={s.narration}
              style={{
                background: C.panel,
                color: running === s.id ? C.amber : C.text,
                border: `1px solid ${C.border}`,
                padding: '8px 12px',
                borderRadius: 4,
              }}
            >
              {running === s.id ? '⏳ ' : '▶ '}
              {s.name || s.id}
            </button>
          ))}
          <button
            type="button"
            onClick={stopOrReset}
            style={{
              background: C.panel,
              color: running ? C.red : C.dim,
              border: `1px solid ${C.border}`,
              padding: '8px 12px',
              borderRadius: 4,
            }}
          >
            {running ? '■ Stop' : '■ Reset'}
          </button>
        </div>

        <div style={{ color: C.dim, fontSize: 12, marginBottom: 4 }}>── live run output ──</div>
        <div
          style={{
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            padding: 10,
            height: 220,
            overflowY: 'auto',
            fontSize: 13,
          }}
        >
          {steps.length === 0 && (
            <div style={{ color: C.dim }}>run a scenario to see output here…</div>
          )}
          {steps.map((s, i) => (
            <div
              key={i}
              style={{
                color: statusColor(s.status, s.blocked),
                fontWeight: s.realAsset ? 800 : s.blocked ? 700 : 400,
                marginBottom: 2,
              }}
            >
              {typeof s.atMs === 'number' ? `+${(s.atMs / 1000).toFixed(1)}s` : '·'} {s.kind}{' '}
              {s.label} → {s.detail}
              {s.realAsset ? '  ⚠ REAL ASSET TOUCHED' : ''}
            </div>
          ))}
          {doneInfo && (
            <div style={{ color: C.green, marginTop: 6 }}>
              ✔ done · {doneInfo.steps} steps · {doneInfo.blockedCount} blocked
            </div>
          )}
        </div>
      </section>

      {/* Region 2: Manual console */}
      <section>
        <div style={{ color: C.dim, letterSpacing: 1, marginBottom: 8 }}>MANUAL CONSOLE</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {/* Web panel */}
          <div
            style={{
              flex: '1 1 320px',
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              padding: 12,
            }}
          >
            <div style={{ color: C.dim, marginBottom: 8 }}>── Web ──</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
                <option>DELETE</option>
              </select>
              <input
                style={{ flex: 1 }}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/admin"
              />
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                style={{ width: 140 }}
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
                placeholder="header name"
              />
              <input
                style={{ flex: 1 }}
                value={headerValue}
                onChange={(e) => setHeaderValue(e.target.value)}
                placeholder="header value (e.g. Bearer acme_live_...)"
              />
            </div>
            <button
              type="button"
              onClick={sendHttp}
              style={{
                background: C.amber,
                color: '#2a1a00',
                border: 'none',
                padding: '6px 14px',
                borderRadius: 3,
                fontWeight: 700,
              }}
            >
              Send request
            </button>
            {httpResult && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <div>
                  status: <b>{httpResult.status}</b> {httpResult.isDecoy ? '(decoy)' : ''}
                </div>
                {httpResult.body ? (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: 'pointer', color: C.dim }}>response body</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
                      {httpResult.body}
                    </pre>
                  </details>
                ) : null}
                {httpResult.blocked && <Banner text="⛔ BLOCKED BY LXS" />}
              </div>
            )}
            {!httpResult && (
              <div style={{ color: C.dim, marginTop: 10, fontSize: 13 }}>
                send a request to see the response
              </div>
            )}
          </div>

          {/* SSH panel */}
          <div
            style={{
              flex: '1 1 320px',
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              padding: 12,
            }}
          >
            <div style={{ color: C.dim, marginBottom: 8 }}>── SSH ──</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                style={{ flex: 1 }}
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                placeholder="user"
              />
              <input
                style={{ flex: 1 }}
                type="password"
                value={sshPass}
                onChange={(e) => setSshPass(e.target.value)}
                placeholder="pass"
              />
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => sshConnectAndMaybeRun(false)}
                style={{
                  background: C.panel,
                  border: `1px solid ${C.border}`,
                  color: C.text,
                  padding: '6px 10px',
                  borderRadius: 3,
                }}
              >
                Connect / Login
              </button>
              <button
                type="button"
                onClick={() => sshConnectAndMaybeRun(true)}
                style={{
                  background: C.green,
                  border: 'none',
                  color: '#042604',
                  padding: '6px 10px',
                  borderRadius: 3,
                  fontWeight: 700,
                }}
              >
                Login + Run
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                style={{ flex: 1 }}
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                placeholder="ls -la"
              />
              <button
                type="button"
                onClick={() => sshRunCommand()}
                style={{
                  background: C.amber,
                  border: 'none',
                  color: '#2a1a00',
                  padding: '6px 10px',
                  borderRadius: 3,
                  fontWeight: 700,
                }}
              >
                Run command
              </button>
            </div>
            {sshResult && (
              <div style={{ marginTop: 6, fontSize: 13 }}>
                <div>
                  {sshResult.action}: <b>{sshResult.ok ? 'accepted' : 'failed'}</b>{' '}
                  {sessionId ? `· session ${sessionId}` : ''}
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
                  {sshResult.output}
                </pre>
                {sshResult.refused && <Banner text="⛔ CONNECTION REFUSED" />}
              </div>
            )}
            {!sshResult && (
              <div style={{ color: C.dim, marginTop: 10, fontSize: 13 }}>
                login + run a command to see output
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
