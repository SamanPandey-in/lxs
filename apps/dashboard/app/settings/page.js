"use client";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { DigestSettings } from "@/components/retention/digest";
import DataPanel from "@/components/settings/data-panel";
import MembersPanel from "@/components/settings/members-panel";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  PageLoading,
  Select,
  Switch,
} from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/workspace";
import { api, PROJECT, setActiveProject } from "@/lib/core";
import { useAsync, useCopy } from "@/lib/hooks";
import { useMe } from "@/lib/identity";
import { toast } from "@/lib/toast";

// Non-empty, trimmed allowlist lines.
const normAllow = (s) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

// Returns the lines that are not a valid IPv4/IPv6 address or CIDR range.
function invalidCidrs(lines) {
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}(\/(\d|[12]\d|3[0-2]))?$/;
  const v6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
  return lines.filter((l) => {
    if (v4.test(l))
      return l
        .split(/[./]/)
        .slice(0, 4)
        .some((o) => Number(o) > 255);
    return !v6.test(l);
  });
}

const CAPTURE_OPTIONS = [
  { value: "masked", label: "Masked (a***n) + clear for common list" },
  { value: "hash", label: "Salted SHA-256 only" },
  { value: "none", label: "Do not store passwords" },
];

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtDate = (iso, f = dateFmt) => (iso ? f.format(new Date(iso)) : "—");

/** Template D section: title + description on top, content below, full width. */
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

/** Key prefix: always shown in full (they're short), mono, with an icon copy button. */
function KeyPrefix({ prefix }) {
  const [copied, copy] = useCopy();
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="font-mono text-sm text-foreground" translate="no">
        {prefix}…
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Copy key prefix ${prefix}`}
              onClick={() => copy(prefix)}
            />
          }
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy prefix"}</TooltipContent>
      </Tooltip>
    </span>
  );
}

export default function SettingsPage() {
  const { data, error, loading, reload } = useAsync(() => api.settings(PROJECT), []);
  const keyBlocked =
    useMe()?.email_verified === false ? "Confirm your email address to create ingest keys." : null;
  const [keys, setKeys] = useState([]);
  const [allow, setAllow] = useState("");
  const [retention, setRetention] = useState(30);
  const [ai, setAi] = useState(true);
  const [capture, setCapture] = useState("masked");
  const [newKey, setNewKey] = useState(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  // Snapshot of the last-saved values, so "Save changes" knows what (if anything) changed.
  const [baseline, setBaseline] = useState(null);

  useEffect(() => {
    if (!data) return;
    setKeys(data.keys || []);
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

  const badCidrs = invalidCidrs(normAllow(allow));
  const retentionNum = Number(retention);
  const badRetention =
    !Number.isInteger(retentionNum) || retentionNum < 1 || retentionNum > 365
      ? "Enter a whole number of days from 1 to 365."
      : null;
  const invalid = badCidrs.length > 0 || Boolean(badRetention);
  const changes = [];
  if (baseline) {
    if (normAllow(allow).join("\n") !== normAllow(baseline.allow).join("\n"))
      changes.push("allowlist");
    if (retentionNum !== Number(baseline.retention)) changes.push("event retention");
    if (ai !== baseline.ai) changes.push("AI narration");
    if (capture !== baseline.capture) changes.push("credential capture");
  }
  const dirty = changes.length > 0;

  // Warn before leaving with unsaved policy changes (patterns.md §6).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const shell = (children) => (
    <div className="mx-auto flex w-full max-w-[960px] min-w-0 flex-col gap-8">{children}</div>
  );
  if (loading && !data) return shell(<PageLoading label="Loading settings" />);
  if (error && !data) return shell(<ErrorState error={error} onRetry={reload} what="settings" />);

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

  const revokeKey = async () => {
    const key = revoking;
    if (!key) return;
    setRevokeBusy(true);
    try {
      await api.revokeKey(key.id);
      setKeys((current) => current.filter((item) => item.id !== key.id));
      toast(`Revoked ${key.name}`, "warning", "Sensors using it will be refused. Logged to audit.");
      setRevoking(null);
    } catch (err) {
      toast("Could not revoke key", "error", err.message);
    } finally {
      setRevokeBusy(false);
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

  const saveChanges = () => {
    if (!dirty || invalid) return;
    toast(
      "Settings saved",
      "success",
      `Updated ${changes.join(", ")}. Policy version bumped and audited.`,
    );
    setBaseline({ allow, retention: retentionNum, ai, capture });
  };

  return shell(
    <>
      <PageHeader
        title="Settings"
        purpose={`Configuration for ${data?.project?.name || "this project"}. Ingest keys are write-only: a stolen key can't read incidents or other projects.`}
        actions={
          <Button variant="outline" onClick={() => setProjectOpen(true)}>
            <Plus aria-hidden /> New project
          </Button>
        }
      />

      <Section
        title="Ingest keys"
        description="Sensors and the SDK use these to send events. The full key is shown once, when you create it."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={createKey}
            loading={keyBusy}
            disabledReason={keyBlocked}
          >
            {keyBusy ? null : <Plus aria-hidden />} Create key
          </Button>
        }
      >
        <Card flush>
          {keys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No ingest keys"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={createKey}
                  loading={keyBusy}
                  disabledReason={keyBlocked}
                >
                  Create key
                </Button>
              }
            >
              Create a key to connect the SDK and sensors.
            </EmptyState>
          ) : (
            <Table inset>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">Name</TableHead>
                  <TableHead scope="col">Key</TableHead>
                  <TableHead scope="col">Created</TableHead>
                  <TableHead scope="col">Last used</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id} className="h-11">
                    <TableCell>
                      <span className="inline-flex max-w-full items-center gap-2 whitespace-nowrap">
                        <span
                          className="max-w-[28ch] truncate font-medium text-foreground"
                          title={k.name}
                        >
                          {k.name}
                        </span>
                        {(k.scopes || ["ingest"]).map((scope) => (
                          <Badge key={scope} variant="tag" tone="neutral" title={`Scope: ${scope}`}>
                            {scope}
                          </Badge>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <KeyPrefix prefix={k.prefix} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      <time dateTime={k.created_at} title={fmtDate(k.created_at, dateTimeFmt)}>
                        {fmtDate(k.created_at)}
                      </time>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {k.last_used_at ? (
                        <RelativeTime iso={k.last_used_at} />
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        aria-label={`Revoke ${k.name}…`}
                        onClick={() => setRevoking(k)}
                      >
                        <Trash2 aria-hidden /> Revoke…
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </Section>

      <NotificationsPanel />
      <DigestSettings />

      <Section
        title="Detection policy"
        description="What gets scored, how long events are kept, and how attacker credentials are stored."
      >
        <Card flush>
          <div className="flex min-w-0 flex-col gap-6 p-5">
            <Field
              id="allow"
              label="Allowlist: CIDR ranges, one per line"
              hint="Your own scanners and office ranges. Traffic from these is never scored or blocked."
              error={
                badCidrs.length ? `Not a valid IP or CIDR range: ${badCidrs.join(", ")}` : null
              }
            >
              <Textarea
                id="allow"
                name="allowlist"
                rows={5}
                spellCheck={false}
                autoCapitalize="none"
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
                placeholder={"10.0.0.0/8\n192.168.0.0/16\n203.0.113.42"}
                aria-invalid={badCidrs.length > 0 || undefined}
                className="min-h-28 font-mono"
                translate="no"
              />
            </Field>

            <Field
              id="ret"
              label="Event retention (days)"
              hint="Events older than this are deleted permanently and drop out of the audit window."
              error={badRetention}
            >
              <Input
                id="ret"
                name="retention_days"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                aria-invalid={Boolean(badRetention) || undefined}
                className="w-32 tabular-nums"
              />
            </Field>

            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <p id="ai-label" className="m-0 text-base font-medium text-foreground">
                  AI narration
                </p>
                <p className="m-0 mt-0.5 max-w-[60ch] text-sm text-muted-foreground">
                  Generate a plain-English summary for each incident. Falls back to a template when
                  the LLM is down.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="w-6 text-sm text-muted-foreground" aria-hidden>
                  {ai ? "On" : "Off"}
                </span>
                <Switch checked={ai} onChange={setAi} label="AI narration" />
              </div>
            </div>

            <Field
              id="cap"
              label="Credential capture mode"
              hint="How attacker passwords are stored. Common passwords from the bundled list are kept in clear for analysis."
            >
              <Select
                id="cap"
                name="credential_capture"
                value={capture}
                onValueChange={setCapture}
                options={CAPTURE_OPTIONS}
                className="w-full sm:w-96"
              />
            </Field>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
            <p role="status" className="m-0 min-w-0 text-sm text-muted-foreground">
              {!dirty ? (
                <span className="inline-flex items-center gap-1.5">
                  <Check className="size-4 text-ok" aria-hidden /> All changes saved
                </span>
              ) : invalid ? (
                <span className="text-destructive">Fix the highlighted fields to save.</span>
              ) : (
                `Unsaved changes: ${changes.join(", ")}`
              )}
            </p>
            {dirty ? (
              <Button onClick={saveChanges} disabled={invalid}>
                Save changes
              </Button>
            ) : null}
          </div>
        </Card>
      </Section>

      <MembersPanel />
      <DataPanel />

      <Dialog
        open={!!newKey}
        onOpenChange={(open) => {
          if (!open) setNewKey(null);
        }}
      >
        <DialogContent className="gap-4 border border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">Copy your new ingest key</DialogTitle>
            <DialogDescription className="text-base">
              You won't see this key again. Store it in your sensor and SDK environment now.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 py-2 pr-2 pl-3">
            <code
              className="min-w-0 flex-1 font-mono text-sm text-foreground [overflow-wrap:anywhere]"
              translate="no"
            >
              {newKey || ""}
            </code>
            {newKey ? <CopyButton text={newKey} label="Copy key" /> : null}
          </div>
          <DialogFooter className="gap-2">
            <Button onClick={() => setNewKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={revoking ? `Revoke ${revoking.name}?` : "Revoke key?"}
        actions={[{ label: "Revoke key", tone: "danger", busy: revokeBusy, onClick: revokeKey }]}
      >
        <p className="m-0">
          Sensors and SDKs using{" "}
          <span className="font-mono text-foreground" translate="no">
            {revoking?.prefix}…
          </span>{" "}
          will be refused from now on. This can't be undone; create a new key to reconnect them.
        </p>
      </Modal>

      <Modal
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        title="Create a project"
        actions={[
          {
            label: "Create project",
            busy: projectBusy,
            disabled: !projectName.trim(),
            onClick: createProject,
          },
        ]}
      >
        <Field id="project-name" label="Project name">
          <Input
            id="project-name"
            name="project_name"
            autoComplete="off"
            value={projectName}
            maxLength={128}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="Production app…"
          />
        </Field>
      </Modal>
    </>,
  );
}
