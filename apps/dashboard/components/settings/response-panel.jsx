"use client";
import { Check, Plus, ShieldBan, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  RelativeTime,
  Select,
  StatusDot,
  Switch,
  TableSkeleton,
} from "@/components/ui";
import { Input } from "@/components/ui/input";
import { resolveProject } from "@/lib/core";
import { useAsync } from "@/lib/hooks";
import { identity } from "@/lib/identity";
import {
  DURATION_OPTIONS,
  describePolicy,
  policyError,
  responseApi,
  usageMeter,
} from "@/lib/response";
import { toast } from "@/lib/toast";

const SEVERITY_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High or worse" },
  { value: "medium", label: "Medium or worse" },
];
const MODE_OPTIONS = [
  { value: "monitor", label: "Monitor: record “would block”, change nothing" },
  { value: "enforce", label: "Enforce: block automatically" },
];
const LABELS = [
  { value: "targeted", label: "Targeted" },
  { value: "opportunistic", label: "Opportunistic" },
  { value: "noise", label: "Noise" },
];

function Section({ title, description, action, children }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={id} className="m-0 text-lg font-semibold text-foreground">
            {title}
          </h2>
          {description ? (
            <p className="m-0 mt-0.5 max-w-[70ch] text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="m-0 text-base font-medium text-foreground">{label}</p>
        {hint ? (
          <p className="m-0 mt-0.5 max-w-[60ch] text-sm text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/* ───────── auto-block policy ───────── */

function AutoBlockCard() {
  const { data, error, loading, reload } = useAsync(() => responseApi.policy(), []);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(null);

  useEffect(() => {
    if (data?.policy)
      setForm({ ...data.policy, duration_hours: String(data.policy.duration_hours) });
  }, [data]);

  if (loading && !data) return <TableSkeleton rows={3} cols={2} />;
  if (error && !data)
    return <ErrorState error={error} onRetry={reload} what="the auto-block policy" />;
  if (!form) return null;

  const body = { ...form, duration_hours: Number(form.duration_hours) };
  const err = policyError(body);
  const dirty = JSON.stringify(body) !== JSON.stringify(data.policy);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (err) return;
    setSaving(true);
    try {
      await responseApi.savePolicy(body);
      toast("Auto-block policy saved", "success", "Logged to audit.");
      reload();
    } catch (e) {
      toast("Could not save the policy", "error", e.message);
    } finally {
      setSaving(false);
    }
  };

  const undo = async (b) => {
    setUndoing(b.id);
    try {
      await responseApi.undoBlock(b.id);
      toast(`Unblocked ${b.ip}`, "success", "The policy will not block this incident again.");
      reload();
    } catch (e) {
      toast(`Couldn't unblock ${b.ip}`, "error", e.message);
    } finally {
      setUndoing(null);
    }
  };

  const recent = [
    ...(data.recent_blocks || []).map((b) => ({ ...b, kind: "block", at: b.created_at })),
    ...(data.recent_decisions || []).map((d) => ({ ...d, kind: d.type, ip: d.params?.ip })),
  ]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 10);

  return (
    <Card flush>
      <div className="flex min-w-0 flex-col gap-5 p-5">
        <ToggleRow
          label="Auto-block"
          hint="Off by default. A fixed, audited rule: no AI is involved in the decision. Allowlisted sources, the platform's own ranges and private addresses are never blocked."
          checked={form.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field id="ab-mode" label="Mode">
            <Select
              id="ab-mode"
              value={form.mode}
              onValueChange={(v) => set({ mode: v })}
              options={MODE_OPTIONS}
              className="w-full"
            />
          </Field>
          <Field id="ab-sev" label="Minimum severity">
            <Select
              id="ab-sev"
              value={form.min_severity}
              onValueChange={(v) => set({ min_severity: v })}
              options={SEVERITY_OPTIONS}
              className="w-full"
            />
          </Field>
          <Field id="ab-dur" label="Block for">
            <Select
              id="ab-dur"
              value={form.duration_hours}
              onValueChange={(v) => set({ duration_hours: v })}
              options={DURATION_OPTIONS}
              className="w-full"
            />
          </Field>
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium text-foreground">Incident labels</legend>
            <div className="flex flex-wrap gap-4">
              {LABELS.map((l) => (
                <Checkbox
                  key={l.value}
                  label={l.label}
                  checked={form.labels.includes(l.value)}
                  onCheckedChange={(on) =>
                    set({
                      labels: on
                        ? [...form.labels, l.value]
                        : form.labels.filter((x) => x !== l.value),
                    })
                  }
                />
              ))}
            </div>
            <span className="text-xs text-muted-foreground">None ticked = any label.</span>
          </fieldset>
        </div>
        <ToggleRow
          label="Only when a real asset was touched"
          hint="Require the attacker to have reached a protected (non-decoy) route or asset."
          checked={form.require_real_asset_touch}
          onChange={(v) => set({ require_real_asset_touch: v })}
        />
        <ToggleRow
          label="Allow private address ranges"
          hint="For lab setups only. Off: 10/8, 172.16/12, 192.168/16, loopback, CGNAT and link-local are never blocked."
          checked={form.allow_private}
          onChange={(v) => set({ allow_private: v })}
        />
        <p className="m-0 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
          {form.enabled
            ? describePolicy(body)
            : "Auto-block is off. Nothing is blocked automatically."}
          {form.enabled && form.mode === "monitor"
            ? " Monitor mode: only recorded, never applied."
            : ""}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
        <p role="status" className="m-0 text-sm text-muted-foreground">
          {err ? (
            <span className="text-destructive">{err}</span>
          ) : dirty ? (
            "Unsaved changes"
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-4 text-ok" aria-hidden /> Saved
            </span>
          )}
        </p>
        {dirty ? (
          <Button onClick={save} loading={saving} disabled={Boolean(err)}>
            Save policy
          </Button>
        ) : null}
      </div>
      {recent.length ? (
        <ul className="m-0 list-none border-t border-border p-0">
          {recent.map((r) => (
            <li
              key={`${r.kind}-${r.id}`}
              className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0"
            >
              <span className="font-mono text-sm text-foreground" translate="no">
                {r.ip || "—"}
              </span>
              {r.kind === "block" ? (
                r.removed_at ? (
                  <StatusDot tone="neutral">Undone</StatusDot>
                ) : (
                  <StatusDot tone="ok">Blocked</StatusDot>
                )
              ) : r.kind === "would_block" ? (
                <Badge variant="tag" tone="info">
                  Would block
                </Badge>
              ) : (
                <Badge variant="tag" tone="warn" title={r.params?.reason}>
                  Refused: {String(r.params?.reason || "").replace(/_/g, " ")}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                <RelativeTime iso={r.at} />
              </span>
              {r.kind === "block" && !r.removed_at ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  loading={undoing === r.id}
                  onClick={() => undo(r)}
                  aria-label={`Undo auto-block of ${r.ip}`}
                >
                  {undoing === r.id ? null : <Undo2 aria-hidden />} Undo
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/* ───────── Slack app ───────── */

function SlackCard() {
  const { data, error, loading, reload } = useAsync(() => responseApi.slack(), []);
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState([]);
  const [links, setLinks] = useState(null);

  useEffect(() => {
    if (!data) return;
    setTeam(data.team_id || "");
    setLinks(
      (data.user_links || []).map((l) => ({
        key: l.slack_user_id,
        slack_user_id: l.slack_user_id,
        user_id: l.user_id,
      })),
    );
  }, [data]);
  useEffect(() => {
    (async () => {
      try {
        const p = await identity.project(await resolveProject());
        const m = await identity.members(p.org_id);
        setMembers(m?.members || []);
      } catch {
        setMembers([]);
      }
    })();
  }, []);

  if (loading && !data) return <TableSkeleton rows={2} cols={2} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} what="the Slack app" />;

  const save = async () => {
    setBusy(true);
    try {
      await responseApi.saveSlack({
        ...(secret.trim() && { signing_secret: secret.trim() }),
        ...(token.trim() && { bot_token: token.trim() }),
        team_id: team.trim() || null,
      });
      setSecret("");
      setToken("");
      toast("Slack app saved", "success", "Critical alerts now carry Block 24h / Ignore.");
      reload();
    } catch (e) {
      toast("Could not save the Slack app", "error", e.message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await responseApi.removeSlack();
      toast("Slack app disconnected", "warning", "Alerts no longer carry buttons.");
      reload();
    } catch (e) {
      toast("Could not disconnect", "error", e.message);
    } finally {
      setBusy(false);
    }
  };
  const saveLinks = async () => {
    setBusy(true);
    try {
      const clean = (links || []).filter((l) => l.slack_user_id.trim() && l.user_id);
      await responseApi.saveSlackLinks(
        clean.map((l) => ({ slack_user_id: l.slack_user_id.trim(), user_id: l.user_id })),
      );
      toast("Slack users linked", "success");
      reload();
    } catch (e) {
      toast("Could not save links", "error", e.message);
    } finally {
      setBusy(false);
    }
  };
  const memberOptions = members.map((m) => ({
    value: m.user_id,
    label: `${m.email || m.name} (${m.role})`,
  }));

  return (
    <Card flush>
      <div className="flex min-w-0 flex-col gap-4 p-5">
        <span className="inline-flex items-center gap-2">
          <StatusDot tone={data.configured ? "ok" : "neutral"}>
            {data.configured ? "Slack app connected" : "No Slack app"}
          </StatusDot>
          {data.has_bot_token ? (
            <Badge variant="tag" tone="neutral" title="Slack users are matched to members by email">
              bot token
            </Badge>
          ) : null}
        </span>
        <p className="m-0 max-w-[70ch] text-sm text-muted-foreground">
          Incoming webhooks cannot send button clicks back, so “Block 24h” needs a Slack app. Create
          one, enable Interactivity with this Request URL, and post alerts through the app's own
          incoming webhook. See docs/ALERTS.md.
        </p>
        <Field id="slack-url" label="Interactivity Request URL">
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-sm" translate="no">
              {data.request_url}
            </code>
            <CopyButton text={data.request_url} label="Copy request URL" />
          </div>
        </Field>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field
            id="slack-secret"
            label="Signing secret"
            hint={
              data.configured
                ? "Stored encrypted. Leave blank to keep."
                : "Basic Information → App Credentials."
            }
          >
            <Input
              id="slack-secret"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            id="slack-token"
            label="Bot token (optional)"
            hint="xoxb-… with users:read.email, to match Slack users to members by email."
          >
            <Input
              id="slack-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            id="slack-team"
            label="Workspace ID (optional)"
            hint="T0123ABCD. Clicks from other workspaces are refused."
          >
            <Input
              id="slack-team"
              autoComplete="off"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
        {data.configured ? (
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium text-foreground">
              Linked Slack users {data.has_bot_token ? "(fallback when email does not match)" : ""}
            </legend>
            {(links || []).map((l, idx) => (
              <div key={l.key} className="flex min-w-0 flex-wrap items-center gap-2">
                <Input
                  aria-label="Slack user ID"
                  placeholder="U0123ABCD"
                  value={l.slack_user_id}
                  onChange={(e) =>
                    setLinks((ls) =>
                      ls.map((x, i) => (i === idx ? { ...x, slack_user_id: e.target.value } : x)),
                    )
                  }
                  className="w-40 font-mono"
                />
                <Select
                  aria-label="LXS member"
                  value={l.user_id}
                  onValueChange={(v) =>
                    setLinks((ls) => ls.map((x, i) => (i === idx ? { ...x, user_id: v } : x)))
                  }
                  options={memberOptions}
                  className="w-full sm:w-80"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove link"
                  onClick={() => setLinks((ls) => ls.filter((_, i) => i !== idx))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setLinks((ls) => [
                    ...(ls || []),
                    { key: `new-${Date.now()}`, slack_user_id: "", user_id: "" },
                  ])
                }
              >
                <Plus aria-hidden /> Link a Slack user
              </Button>
              <Button variant="outline" size="sm" onClick={saveLinks} loading={busy}>
                Save links
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
        {data.configured ? (
          <Button variant="ghost" className="text-destructive" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : null}
        <Button onClick={save} loading={busy} disabled={!data.configured && !secret.trim()}>
          {data.configured ? "Update Slack app" : "Connect Slack app"}
        </Button>
      </div>
    </Card>
  );
}

/* ───────── AI usage meter (H7) ───────── */

export function AiUsageMeter() {
  const { data, error, loading, reload } = useAsync(() => responseApi.llmUsage(), []);
  if (loading && !data) return <TableSkeleton rows={1} cols={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} what="AI usage" />;
  const m = usageMeter(data);
  if (!m) return null;
  const bar = { ok: "bg-ok", warn: "bg-warn", bad: "bg-destructive" }[m.tone];
  return (
    <Card flush>
      <div className="flex min-w-0 flex-col gap-3 p-5">
        {!data.llm_configured ? (
          <EmptyState icon={Sparkles} title="No AI provider configured">
            Incidents use template summaries. Set LLM_API_KEY on the server to enable AI narration.
          </EmptyState>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
          <span className="text-base font-medium text-foreground tabular-nums">
            {m.used} / {m.cap} AI calls today
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">
            {m.costToday} today · {m.costMonth} this month (estimate)
          </span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label="AI calls used today"
          aria-valuemin={0}
          aria-valuemax={m.cap}
          aria-valuenow={m.used}
        >
          <div className={`h-full ${bar}`} style={{ width: `${m.pct}%` }} />
        </div>
        <p className="m-0 text-sm text-muted-foreground tabular-nums">
          {m.remaining} left today for this project · organization {m.orgUsed} / {m.orgCap} ·{" "}
          {m.tokensToday.toLocaleString()} tokens today
          {m.fallbacksToday ? ` · ${m.fallbacksToday} template fallbacks` : ""}
        </p>
        {m.capped ? (
          <p className="m-0 text-sm text-destructive">
            {m.cappedText}. New incidents get the template summary until the limit resets (00:00
            UTC).
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** Settings → Response: auto-block policy, Slack app for one-click blocks, and AI usage. */
export default function ResponsePanel() {
  return (
    <>
      <Section
        title="Response automation"
        description="Deterministic, audited and reversible. The AI explains incidents; it never takes an action."
      >
        <AutoBlockCard />
      </Section>
      <Section
        title="Block from Slack"
        description="Adds Block 24h and Ignore buttons to Critical alerts. Clicks are verified with your Slack app's signing secret and need an analyst."
        action={<ShieldBan className="size-5 text-muted-foreground" aria-hidden />}
      >
        <SlackCard />
      </Section>
      <Section
        title="AI usage"
        description="Calls, tokens and estimated cost against the daily limits."
      >
        <AiUsageMeter />
      </Section>
    </>
  );
}
