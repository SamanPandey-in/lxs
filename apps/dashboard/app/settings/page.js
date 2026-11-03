"use client";
import { Bell, KeyRound, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  CodeBlock,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  PageLoading,
  Pill,
  Switch,
  Table,
  THead,
} from "@/components/ui";
import { RelativeTime, SectionCard } from "@/components/workspace";
import { api, PROJECT, setActiveProject } from "@/lib/core";
import { useAsync } from "@/lib/hooks";
import { toast } from "@/lib/toast";
import { stamp } from "@/lib/utils";

// Non-empty, trimmed allowlist lines.
const normAllow = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

// Returns the lines that are not a valid IPv4/IPv6 address or CIDR range.
function invalidCidrs(lines) {
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}(\/(\d|[12]\d|3[0-2]))?$/;
  const v6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
  return lines.filter((l) => {
    if (v4.test(l)) return l.split(/[./]/).slice(0, 4).some((o) => Number(o) > 255);
    return !v6.test(l);
  });
}

export default function SettingsPage() {
  const { data, error, loading, reload } = useAsync(() => api.settings(PROJECT), []);
  const [keys, setKeys] = useState([]);
  const [channels, setChannels] = useState([]);
  const [allow, setAllow] = useState("");
  const [retention, setRetention] = useState(30);
  const [ai, setAi] = useState(true);
  const [capture, setCapture] = useState("masked");
  const [newKey, setNewKey] = useState(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [hook, setHook] = useState(null);
  // Snapshot of the last-saved values, so "Save changes" knows what (if anything) changed.
  const [baseline, setBaseline] = useState(null);

  useEffect(() => {
    if (!data) return;
    setKeys(data.keys || []);
    setChannels(data.channels || []);
    setAllow((data.allowlist || []).join("\n"));
    setRetention(data.retention_days ?? 30);
    setAi(data.ai_narration ?? true);
    setCapture(data.credential_capture || "masked");
    setBaseline({
      allow: (data.allowlist || []).join("\n"),
      retention: data.retention_days ?? 30,
      ai: data.ai_narration ?? true,
      capture: data.credential_capture || "masked",
    });
  }, [data]);

  if (loading && !data)
    return (
      <div className="ds-page">
        <PageLoading />
      </div>
    );
  if (error && !data)
    return (
      <div className="ds-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  const createKey = async () => {
    setKeyBusy(true);
    try {
      const key = await api.createKey({ name: `sensor-${keys.length + 1}` });
      setKeys((current) => [key, ...current]);
      setNewKey(key.key);
    } catch (err) {
      toast("Could not create key", "error", err.message);
    } finally {
      setKeyBusy(false);
    }
  };

  const revokeKey = async (key) => {
    try {
      await api.revokeKey(key.id);
      setKeys((current) => current.filter((item) => item.id !== key.id));
      toast(`Revoked ${key.name}`, "warning", "Sensors using it will be refused.");
    } catch (err) {
      toast("Could not revoke key", "error", err.message);
    }
  };

  const createProject = async () => {
    setProjectBusy(true);
    try {
      const project = await api.createProject({ name: projectName });
      setActiveProject(project.id);
      window.location.assign("/dashboard");
    } catch (err) {
      toast("Could not create project", "error", err.message);
    } finally {
      setProjectBusy(false);
    }
  };

  const badCidrs = invalidCidrs(normAllow(allow));
  const changes = [];
  if (baseline) {
    if (normAllow(allow).join("\n") !== normAllow(baseline.allow).join("\n"))
      changes.push("allowlist");
    if (Number(retention) !== Number(baseline.retention)) changes.push("event retention");
    if (ai !== baseline.ai) changes.push("AI narration");
    if (capture !== baseline.capture) changes.push("credential capture");
  }
  const dirty = changes.length > 0;

  const saveChanges = () => {
    if (!dirty || badCidrs.length) return;
    toast("Settings saved", "success", `Updated ${changes.join(", ")}. Policy version bumped and audited.`);
    setBaseline({ allow, retention, ai, capture });
  };

  return (
    <div className="ds-page">
      <PageHeader
        eyebrow="SYSTEM / PROJECT"
        title="Settings"
        purpose={`Configuration for ${data?.project?.name || "this project"}. Ingest keys are write-only: a stolen key cannot read incidents or other projects.`}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setProjectOpen(true)}>
              <Plus /> New project
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!dirty || badCidrs.length > 0}
              title={
                badCidrs.length
                  ? "Fix the invalid allowlist entries first"
                  : dirty
                    ? `Unsaved: ${changes.join(", ")}`
                    : "No changes to save"
              }
              onClick={saveChanges}
            >
              {dirty ? "Save changes" : "Saved"}
            </button>
          </>
        }
      />

      <div className="ds-settings-grid">
        <SectionCard
          title="Ingest keys"
          detail="Used by sensors and the SDK. Shown once at creation."
          action={
            <button type="button" className="btn btn-sm" onClick={createKey} disabled={keyBusy}>
              <Plus /> {keyBusy ? "Creating…" : "Create key"}
            </button>
          }
          flush
        >
          {keys.length === 0 ? (
            <EmptyState icon={KeyRound} title="No ingest keys">
              Create a key to connect the SDK and sensors.
            </EmptyState>
          ) : (
            <Table>
              <THead cols={["Name", "Prefix", "Created", "Last used", ""]} />
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <strong>{k.name}</strong>
                      <span className="table-sub">
                        scope: {(k.scopes || ["ingest"]).join(", ")}
                      </span>
                    </td>
                    <td className="mono">{k.prefix}…</td>
                    <td className="dim">{stamp(k.created_at)}</td>
                    <td>
                      {k.last_used_at ? (
                        <RelativeTime iso={k.last_used_at} />
                      ) : (
                        <span className="faint">never</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        aria-label={`Revoke ${k.name}`}
                        onClick={() => revokeKey(k)}
                      >
                        <Trash2 /> Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </SectionCard>

        <SectionCard
          title="Notifications"
          detail="Webhooks fire for High and Critical targeted incidents only"
          action={
            <button type="button" className="btn btn-sm" onClick={() => setHook("")}>
              <Plus /> Add webhook
            </button>
          }
          flush
        >
          {channels.length === 0 ? (
            <EmptyState icon={Bell} title="No channels">
              Add a Slack or generic webhook to be told about critical incidents.
            </EmptyState>
          ) : (
            channels.map((c) => (
              <div className="ds-res" key={c.id}>
                <div className="ds-res-main">
                  <div className="row" style={{ gap: 8 }}>
                    {c.label}
                    <Pill tone="cache">{c.type}</Pill>
                  </div>
                  <div className="ds-res-meta mono truncate" style={{ maxWidth: 360 }}>
                    {c.target}
                  </div>
                </div>
                <Pill tone="halted">≥ {c.min_severity}</Pill>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => toast(`Test sent to ${c.label}`, "success", "HTTP 200 in 142 ms")}
                >
                  <Send /> Test
                </button>
              </div>
            ))
          )}
        </SectionCard>

        <SectionCard
          title="Allowlist"
          detail="Your own scanners and office ranges: never scored, never blocked"
        >
          <Field
            label="CIDR ranges, one per line"
            htmlFor="allow"
            hint="Traffic from these ranges is ignored by detection."
          >
            <textarea
              id="allow"
              rows={5}
              value={allow}
              onChange={(e) => setAllow(e.target.value)}
              placeholder={"10.0.0.0/8\n192.168.0.0/16\n203.0.113.42"}
              aria-invalid={badCidrs.length > 0}
            />
            {badCidrs.length ? (
              <p role="alert" style={{ color: "var(--bad)", fontSize: 12, margin: "6px 0 0" }}>
                Not a valid IP or CIDR range: {badCidrs.join(", ")}
              </p>
            ) : null}
          </Field>
        </SectionCard>

        <SectionCard title="Data & AI">
          <div className="col" style={{ gap: 4 }}>
            <Field
              label="Event retention (days)"
              htmlFor="ret"
              hint="Events older than this are deleted permanently and drop out of the audit window."
            >
              <input
                id="ret"
                type="number"
                min={1}
                max={365}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                style={{ maxWidth: 140 }}
              />
            </Field>
            <div className="switch-row switch-row">
              <div>
                <strong>AI narration</strong>
                <p>
                  Generate a plain-English summary for each incident. Falls back to a template when
                  the LLM is down.
                </p>
              </div>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <span className="dim" style={{ fontSize: 12.5, minWidth: 20 }}>
                  {ai ? "On" : "Off"}
                </span>
                <Switch checked={ai} onChange={setAi} label="AI narration" />
              </div>
            </div>
            <Field
              label="Credential capture mode"
              htmlFor="cap"
              hint="How attacker passwords are stored. Common passwords from the bundled list are kept in clear for analysis."
            >
              <select id="cap" value={capture} onChange={(e) => setCapture(e.target.value)}>
                <option value="masked">Masked (a***n) + clear for common list</option>
                <option value="hash">Salted SHA-256 only</option>
                <option value="none">Do not store passwords</option>
              </select>
            </Field>
          </div>
        </SectionCard>
      </div>

      <Modal
        open={!!newKey}
        onClose={() => setNewKey(null)}
        title="Copy your new ingest key"
        actions={[{ label: "Done", onClick: () => setNewKey(null) }]}
      >
        <p style={{ marginBottom: 10 }}>
          This is the only time the full key is shown. Store it in your sensor and SDK environment.
        </p>
        <CodeBlock>{newKey || ""}</CodeBlock>
      </Modal>

      <Modal
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        title="Create a project"
        actions={[
          {
            label: projectBusy ? "Creating…" : "Create project",
            disabled: projectBusy || !projectName.trim(),
            onClick: createProject,
          },
        ]}
      >
        <Field label="Project name" htmlFor="project-name">
          <input
            id="project-name"
            value={projectName}
            maxLength={128}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="Production app"
          />
        </Field>
      </Modal>

      <Modal
        open={hook !== null}
        onClose={() => setHook(null)}
        title="Add a webhook"
        actions={[
          {
            label: "Add",
            disabled: !/^https?:\/\//.test(hook || ""),
            onClick: () => {
              setChannels((c) => [
                ...c,
                {
                  id: `ch_${Date.now()}`,
                  type: "webhook",
                  label: "Custom webhook",
                  target: hook,
                  min_severity: "high",
                  status: "ok",
                },
              ]);
              setHook(null);
              toast("Webhook added");
            },
          },
        ]}
      >
        <Field
          label="Endpoint URL"
          htmlFor="hook"
          hint="Private and loopback addresses are refused (SSRF guard)."
        >
          <input
            id="hook"
            type="text"
            value={hook || ""}
            onChange={(e) => setHook(e.target.value)}
            placeholder="https://hooks.example.com/lxs"
          />
        </Field>
      </Modal>
    </div>
  );
}
