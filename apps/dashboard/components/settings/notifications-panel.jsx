"use client";
import { Bell, Plus, Send, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  RelativeTime,
  Select,
  StatusDot,
  Switch,
  TableSkeleton,
} from "@/components/ui";
import { Input } from "@/components/ui/input";
import { channelHealth, channelsApi, describeTestResult } from "@/lib/channels";
import { useAsync } from "@/lib/hooks";
import { toast } from "@/lib/toast";

const TYPE_OPTIONS = [
  { value: "slack", label: "Slack (incoming webhook)" },
  { value: "webhook", label: "Generic webhook (signed JSON)" },
];
const SEVERITY_OPTIONS = [
  { value: "critical", label: "Critical only" },
  { value: "high", label: "High and above" },
  { value: "medium", label: "Medium and above" },
  { value: "low", label: "Everything" },
];
const LABELS = [
  { value: "targeted", label: "Targeted" },
  { value: "opportunistic", label: "Opportunistic" },
  { value: "noise", label: "Noise" },
];
const SEVERITY_TEXT = Object.fromEntries(SEVERITY_OPTIONS.map((o) => [o.value, o.label]));
const EMPTY_FORM = {
  type: "slack",
  name: "",
  url: "",
  min_severity: "high",
  labels: ["targeted"],
};

/** Green healthy / red failing (with the last error) / grey never sent. */
function Health({ channel }) {
  const h = channelHealth(channel);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm">
        <StatusDot tone={h.tone}>{h.label}</StatusDot>
        {channel.last_delivered_at ? (
          <span className="text-muted-foreground">
            last sent <RelativeTime iso={channel.last_delivered_at} />
          </span>
        ) : null}
      </span>
      {h.detail ? (
        <span
          className="max-w-[60ch] truncate text-xs text-destructive"
          title={h.detail}
          translate="no"
        >
          {h.detail}
        </span>
      ) : null}
    </div>
  );
}

function ChannelRow({ channel, onTested, onDelete, onChanged }) {
  const [busy, setBusy] = useState(false);
  const setDigest = async (on) => {
    onChanged({ ...channel, digest: on });
    try {
      onChanged(await channelsApi.update(channel.id, { digest: on }));
    } catch (err) {
      onChanged(channel);
      toast("Could not change the weekly digest", "error", err.message);
    }
  };
  const sendTest = async () => {
    setBusy(true);
    try {
      const r = await channelsApi.test(channel.id);
      onTested(channel.id, r);
      toast(
        r.delivered ? `Test delivered to ${channel.name}` : `Test to ${channel.name} failed`,
        r.delivered ? "success" : "error",
        describeTestResult(r),
      );
    } catch (err) {
      toast("Could not send test", "error", err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{channel.name}</span>
          <Badge variant="tag" tone="info">
            {channel.type === "slack" ? "Slack" : "Webhook"}
          </Badge>
          {channel.signed ? (
            <Badge variant="tag" tone="neutral" title="Requests carry X-LXS-Signature">
              signed
            </Badge>
          ) : null}
          {channel.enabled === false ? (
            <Badge variant="tag" tone="warn">
              disabled
            </Badge>
          ) : null}
        </span>
        {channel.target ? (
          <span
            className="truncate font-mono text-sm text-muted-foreground"
            title={channel.target}
            translate="no"
          >
            {channel.target}
          </span>
        ) : null}
        <Health channel={channel} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={Boolean(channel.digest)}
            onChange={setDigest}
            label={`Send weekly digest to ${channel.name}`}
          />
          <span aria-hidden>Weekly digest</span>
        </span>
        <Badge
          variant="tag"
          tone="neutral"
          title={`Labels: ${(channel.labels || []).join(", ") || "any"}`}
        >
          {SEVERITY_TEXT[channel.min_severity] || channel.min_severity}
        </Badge>
        <Button variant="outline" size="sm" onClick={sendTest} loading={busy}>
          {busy ? null : <Send aria-hidden />} Send test
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:bg-destructive/10"
          aria-label={`Delete ${channel.name}…`}
          onClick={() => onDelete(channel)}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

export function NotificationsPanel() {
  const headingId = useId();
  const { data, error, loading, reload } = useAsync(() => channelsApi.list(), []);
  // Local edits (create, delete, test results) layered over the last load.
  const [local, setLocal] = useState(null);
  const channels = local ?? data ?? [];
  const [form, setForm] = useState(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const update = (fn) => setLocal((cur) => fn(cur ?? data ?? []));
  const retry = () => {
    setLocal(null);
    reload();
  };

  const urlError =
    form && !/^https?:\/\/\S+$/.test(form.url.trim())
      ? "Enter a full URL that starts with https://."
      : null;
  const nameError = form && !form.name.trim() ? "Give the channel a name." : null;

  const closeForm = () => {
    setForm(null);
    setTouched(false);
  };

  const create = async () => {
    setTouched(true);
    if (urlError || nameError) return;
    setSaving(true);
    try {
      const c = await channelsApi.create({
        type: form.type,
        name: form.name.trim(),
        url: form.url.trim(),
        min_severity: form.min_severity,
        labels: form.labels,
      });
      const { signing_secret, ...channel } = c;
      update((list) => [channel, ...list]);
      closeForm();
      if (signing_secret) setSecret(signing_secret);
      else toast(`Added ${channel.name}`, "success", "Send a test to check it works.");
    } catch (err) {
      toast("Could not add channel", "error", err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const c = deleting;
    if (!c) return;
    setDeleteBusy(true);
    try {
      await channelsApi.remove(c.id);
      update((list) => list.filter((x) => x.id !== c.id));
      setDeleting(null);
      toast(`Deleted ${c.name}`, "warning");
    } catch (err) {
      toast("Could not delete channel", "error", err.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const onTested = (id, r) =>
    update((list) =>
      list.map((c) =>
        c.id === id
          ? {
              ...c,
              last_status: r.delivered ? "ok" : "failed",
              last_error: r.delivered ? null : r.error,
              last_delivered_at: r.delivered ? new Date().toISOString() : c.last_delivered_at,
            }
          : c,
      ),
    );

  const toggleLabel = (value, on) =>
    setForm((f) => ({
      ...f,
      labels: on ? [...new Set([...f.labels, value])] : f.labels.filter((l) => l !== value),
    }));

  return (
    <section id="notifications" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={headingId} className="m-0 text-lg font-semibold text-foreground">
            Notifications
          </h2>
          <p className="m-0 mt-0.5 max-w-[70ch] text-sm text-muted-foreground">
            Slack and webhook alerts for new incidents at or above each channel's severity. One
            message per severity step, with a 10 minute cooldown per attacker.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setForm({ ...EMPTY_FORM })}>
          <Plus aria-hidden /> Add channel
        </Button>
      </div>

      <Card flush>
        {loading && !data ? (
          <TableSkeleton rows={2} cols={3} />
        ) : error && !data ? (
          <ErrorState error={error} onRetry={retry} what="notification channels" />
        ) : channels.length === 0 ? (
          <EmptyState
            icon={Bell}
            title="No channels"
            action={
              <Button variant="outline" size="sm" onClick={() => setForm({ ...EMPTY_FORM })}>
                Add channel
              </Button>
            }
          >
            Add a Slack or generic webhook to be told about high and critical incidents.
          </EmptyState>
        ) : (
          <ul className="m-0 list-none p-0">
            {channels.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                onTested={onTested}
                onDelete={setDeleting}
                onChanged={(next) =>
                  update((list) => list.map((x) => (x.id === next.id ? next : x)))
                }
              />
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={form !== null}
        onClose={closeForm}
        title="Add a notification channel"
        actions={[
          {
            label: "Add channel",
            busy: saving,
            disabled: touched && Boolean(urlError || nameError),
            onClick: create,
          },
        ]}
      >
        {form ? (
          <div className="flex min-w-0 flex-col gap-4">
            <Field id="ch-type" label="Type">
              <Select
                id="ch-type"
                name="type"
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}
                options={TYPE_OPTIONS}
                className="w-full"
              />
            </Field>
            <Field id="ch-name" label="Name" error={touched ? nameError : null}>
              <Input
                id="ch-name"
                name="name"
                autoComplete="off"
                maxLength={64}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={form.type === "slack" ? "#soc-alerts" : "PagerDuty bridge"}
              />
            </Field>
            <Field
              id="ch-url"
              label={form.type === "slack" ? "Slack incoming webhook URL" : "Endpoint URL"}
              hint={
                form.type === "slack"
                  ? "Stored encrypted and never shown again in full."
                  : "Stored encrypted. Requests are signed; you get the signing secret once, next."
              }
              error={touched ? urlError : null}
            >
              <Input
                id="ch-url"
                name="url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder={
                  form.type === "slack"
                    ? "https://hooks.slack.com/services/…"
                    : "https://hooks.example.com/lxs"
                }
                translate="no"
              />
            </Field>
            <Field id="ch-sev" label="Minimum severity">
              <Select
                id="ch-sev"
                name="min_severity"
                value={form.min_severity}
                onValueChange={(v) => setForm((f) => ({ ...f, min_severity: v }))}
                options={SEVERITY_OPTIONS}
                className="w-full"
              />
            </Field>
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-xs font-medium text-muted-foreground">
                Labels (none ticked means any label)
              </legend>
              <div className="flex flex-wrap gap-x-4">
                {LABELS.map((l) => (
                  <Checkbox
                    key={l.value}
                    label={l.label}
                    checked={form.labels.includes(l.value)}
                    onCheckedChange={(on) => toggleLabel(l.value, on)}
                  />
                ))}
              </div>
            </fieldset>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Copy your webhook signing secret"
        hideCancel
        actions={[{ label: "Done", onClick: () => setSecret(null) }]}
      >
        <p className="m-0 mb-3">
          You won't see this again. Use it to verify the{" "}
          <span className="font-mono text-foreground">X-LXS-Signature</span> header (see
          docs/ALERTS.md).
        </p>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 py-2 pr-2 pl-3">
          <code
            className="min-w-0 flex-1 font-mono text-sm text-foreground [overflow-wrap:anywhere]"
            translate="no"
          >
            {secret || ""}
          </code>
          {secret ? <CopyButton text={secret} label="Copy secret" /> : null}
        </div>
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : "Delete channel?"}
        actions={[{ label: "Delete channel", tone: "danger", busy: deleteBusy, onClick: remove }]}
      >
        <p className="m-0">Alerts stop going to this channel. This can't be undone.</p>
      </Modal>
    </section>
  );
}
