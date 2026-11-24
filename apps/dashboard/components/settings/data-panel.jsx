"use client";
import { Archive, Download, RotateCcw, Trash2, UserX } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  TableSkeleton,
} from "@/components/ui";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { resolveProject, setActiveProject } from "@/lib/core";
import { apiHref, dataApi, formatBytes } from "@/lib/data";
import { identity, loadMe } from "@/lib/identity";
import { toast } from "@/lib/toast";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmt = (iso, f = dateTimeFmt) => (iso ? f.format(new Date(iso)) : "—");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STATUS = {
  pending: { tone: "info", label: "Queued" },
  running: { tone: "info", label: "Building" },
  ready: { tone: "ok", label: "Ready" },
  failed: { tone: "bad", label: "Failed" },
  expired: { tone: "neutral", label: "Expired" },
};
const PLAN_LABEL = { free: "Free", team: "Team", custom: "Custom" };
const POLL_MS = 3000;

/**
 * Settings → Data: what this project keeps and for how long, exports, and the two
 * destructive actions (delete project, delete account). Owners act; everyone else reads
 * the retention summary. Every action is confirmed here and audited by the API.
 */
export default function DataPanel() {
  const titleId = useId();
  const [pid, setPid] = useState(null);
  const [project, setProject] = useState(null);
  const [role, setRole] = useState(null);
  const [summary, setSummary] = useState(null);
  const [exports, setExports] = useState(null);
  const [deleted, setDeleted] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const pollRef = useRef(null);

  const isOwner = role === "owner";

  const loadDeleted = useCallback(async (orgs) => {
    const owned = (orgs || []).filter((o) => o.role === "owner");
    const lists = await Promise.all(
      owned.map((o) =>
        dataApi
          .deletedProjects(o.id)
          .then((r) => r.items)
          .catch(() => []),
      ),
    );
    setDeleted(lists.flat().filter((p) => p.restorable));
  }, []);

  const loadExports = useCallback(async (id) => {
    const r = await dataApi.exports(id);
    setExports(r.items);
    return r.items;
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const me = await loadMe(true);
      loadDeleted(me?.orgs);
      const id = await resolveProject();
      const p = await identity.project(id);
      const myRole = me?.orgs?.find((o) => o.id === p.org_id)?.role ?? null;
      setPid(id);
      setProject(p);
      setRole(myRole);
      setSummary(await dataApi.summary(id));
      if (myRole === "owner") await loadExports(id);
    } catch (err) {
      setError(err);
    }
  }, [loadDeleted, loadExports]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while an export is queued or building; stop as soon as none is.
  useEffect(() => {
    clearTimeout(pollRef.current);
    const active = exports?.some((x) => x.status === "pending" || x.status === "running");
    if (!active || !pid) return undefined;
    pollRef.current = setTimeout(() => {
      loadExports(pid).catch(() => {});
    }, POLL_MS);
    return () => clearTimeout(pollRef.current);
  }, [exports, pid, loadExports]);

  const requestExport = async () => {
    setBusy("export");
    try {
      await dataApi.requestExport(pid);
      toast("Export requested", "success", "It is built in the background. Logged to audit.");
      await loadExports(pid);
    } catch (err) {
      toast("Could not start the export", "error", err.message);
    } finally {
      setBusy("");
    }
  };

  const restore = async (p) => {
    setBusy(`restore:${p.id}`);
    try {
      await dataApi.restoreProject(p.id);
      toast(
        `Restored ${p.name}`,
        "success",
        "Its ingest keys stay revoked: create a new key for your sensors.",
      );
      setActiveProject(p.id);
      window.location.assign("/settings");
    } catch (err) {
      toast("Could not restore the project", "error", err.message);
      setBusy("");
    }
  };

  const busyExport = exports?.some((x) => x.status === "pending" || x.status === "running");
  const exportBlocked = !isOwner
    ? "Only owners can export a project."
    : busyExport
      ? "An export is already being built."
      : null;

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0">
        <h2 id={titleId} className="m-0 text-lg font-semibold text-foreground">
          Data
        </h2>
        <p className="m-0 mt-0.5 max-w-[70ch] text-sm text-muted-foreground">
          What {project?.name || "this project"} keeps and for how long, a full export, and
          deletion. Every action here is written to the audit log.
        </p>
      </div>

      {deleted.map((p) => (
        <Alert key={p.id}>
          <Archive aria-hidden />
          <AlertTitle>{p.name} was deleted</AlertTitle>
          <AlertDescription>
            Deleted {fmt(p.deleted_at)}. It is purged for good on {fmt(p.purge_after)}; restore it
            before then to keep its data.
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              loading={busy === `restore:${p.id}`}
              onClick={() => restore(p)}
            >
              <RotateCcw aria-hidden /> Restore
            </Button>
          </AlertAction>
        </Alert>
      ))}

      {error && !summary ? (
        <Card>
          <ErrorState error={error} onRetry={load} what="data settings" />
        </Card>
      ) : (
        <>
          <RetentionCard summary={summary} />
          <Card
            flush
            title="Exports"
            sub={
              summary
                ? `A JSON bundle of everything in this project except secrets. Downloadable for ${plural(summary.export_ttl_hours, "hour")}.`
                : null
            }
            right={
              <Button
                variant="outline"
                size="sm"
                onClick={requestExport}
                loading={busy === "export"}
                disabledReason={summary ? exportBlocked : "Loading"}
              >
                <Download aria-hidden /> Request export
              </Button>
            }
          >
            <ExportList exports={exports} isOwner={isOwner} loading={!summary} />
          </Card>

          <Card title="Danger zone">
            <div className="flex flex-col gap-4">
              <DangerRow
                title="Delete this project"
                body={
                  summary
                    ? `Hides it at once, revokes its ingest keys and stops ingest. You can restore it for ${plural(summary.delete_grace_days, "day")}; after that it and all its data are purged.`
                    : "Hides it at once, revokes its ingest keys and stops ingest."
                }
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setDeleteOpen(true)}
                    disabledReason={
                      !project ? "Loading" : isOwner ? null : "Only owners can delete a project."
                    }
                  >
                    <Trash2 aria-hidden /> Delete project
                  </Button>
                }
              />
              <DangerRow
                title="Delete your account"
                body="Removes you from every organization. Organizations where you are the only member are deleted with their projects. If you are the only owner of a team, make someone else an owner first."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setAccountOpen(true)}
                  >
                    <UserX aria-hidden /> Delete account
                  </Button>
                }
              />
            </div>
          </Card>
        </>
      )}

      <DeleteProjectModal
        open={deleteOpen}
        project={project}
        graceDays={summary?.delete_grace_days}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          setDeleteOpen(false);
          // The deleted project drops out of /v1/projects; let discovery pick another.
          setActiveProject("");
          window.location.assign("/settings");
        }}
      />
      <DeleteAccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
    </section>
  );
}

function DangerRow({ title, body, action }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-2">
      <div className="min-w-0 max-w-[70ch]">
        <p className="m-0 text-sm font-medium text-foreground">{title}</p>
        <p className="m-0 mt-0.5 text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

function RetentionCard({ summary }) {
  const r = summary?.retention;
  const rows = summary
    ? [
        {
          k: "Events",
          v: `${plural(r.events_days, "day")}`,
          hint:
            r.project_days > r.events_days
              ? `Project setting ${r.project_days} days, capped by the plan.`
              : `Project setting; the plan allows up to ${summary.plan.retention_days} days.`,
        },
        {
          k: "Original sensor records",
          v: plural(r.raw_days, "day"),
          hint: "The raw record behind each event. Parsed fields stay for the event's lifetime.",
        },
        {
          k: "Captured passwords",
          v: `hashed after ${plural(r.credential_hash_days, "day")}`,
          hint: "Passwords attackers typed are replaced with a one-way hash; the username and length stay.",
        },
        {
          k: "Deleted projects",
          v: `purged after ${plural(summary.delete_grace_days, "day")}`,
          hint: "Restorable until then from this page.",
        },
      ]
    : [];
  return (
    <Card
      title="Retention"
      right={
        summary ? (
          <Badge variant="tag" tone="neutral">
            {PLAN_LABEL[summary.plan.name] || summary.plan.name} plan
          </Badge>
        ) : null
      }
    >
      {!summary ? (
        <TableSkeleton rows={4} cols={2} />
      ) : (
        <dl className="m-0 grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          {rows.map((row) => (
            <div key={row.k} className="contents">
              <dt className="text-sm text-muted-foreground">{row.k}</dt>
              <dd className="m-0 min-w-0">
                <span className="text-sm font-medium text-foreground">{row.v}</span>
                <span className="block text-xs text-muted-foreground">{row.hint}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function ExportList({ exports, isOwner, loading }) {
  if (!isOwner && !loading)
    return (
      <EmptyState icon={Download} title="Owners only">
        Exports contain every event and incident in the project, so only owners can see them.
      </EmptyState>
    );
  if (loading || !exports) return <TableSkeleton rows={2} cols={4} />;
  if (exports.length === 0)
    return (
      <EmptyState icon={Download} title="No exports yet">
        Request one to get every event, incident and setting as JSON.
      </EmptyState>
    );
  return (
    <Table inset>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">Requested</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col" className="text-right">
            Size
          </TableHead>
          <TableHead scope="col">Available until</TableHead>
          <TableHead scope="col">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {exports.map((x) => {
          const s = STATUS[x.status] || STATUS.failed;
          return (
            <TableRow key={x.id} className="h-11">
              <TableCell className="text-sm whitespace-nowrap">{fmt(x.created_at)}</TableCell>
              <TableCell>
                <Badge variant="status" tone={s.tone} title={x.error || undefined}>
                  {s.label}
                </Badge>
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">
                {formatBytes(x.size_bytes)}
              </TableCell>
              <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                {x.status === "ready" ? fmt(x.expires_at) : "—"}
              </TableCell>
              <TableCell className="text-right">
                {x.download_path ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    nativeButton={false}
                    render={
                      // biome-ignore lint/a11y/useAnchorContent: Base UI's Button renders its children (icon + "Download") inside this anchor
                      <a
                        href={apiHref(x.download_path)}
                        download
                        aria-label={`Download export from ${fmt(x.created_at)}`}
                      />
                    }
                  >
                    <Download aria-hidden /> Download
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function DeleteProjectModal({ open, project, graceDays, onClose, onDeleted }) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const slug = project?.slug || "";
  const matches = confirm.trim() === slug && slug !== "";

  useEffect(() => {
    if (!open) return;
    setConfirm("");
    setError("");
  }, [open]);

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setError("");
    try {
      const r = await dataApi.deleteProject(project.id, confirm.trim());
      toast(
        `Deleted ${project.name}`,
        "warning",
        `Restorable until ${fmt(r.purge_after, dateFmt)}. Logged to audit.`,
      );
      onDeleted();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Delete ${project?.name || "project"}?`}
      actions={[
        { label: "Delete project", tone: "danger", busy, disabled: !matches, onClick: submit },
      ]}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        <p className="m-0">
          Ingest stops now and its {graceDays ?? 7}-day restore window starts. After that the
          project, its events, incidents and exports are purged and cannot be recovered.
        </p>
        <Field
          id="delete-project-confirm"
          label={
            <>
              Type{" "}
              <span className="font-mono text-foreground" translate="no">
                {slug}
              </span>{" "}
              to confirm
            </>
          }
          error={error || null}
        >
          <Input
            id="delete-project-confirm"
            name="confirm"
            autoComplete="off"
            spellCheck={false}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

function DeleteAccountModal({ open, onClose }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setError("");
  }, [open]);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError("");
    try {
      await dataApi.deleteAccount(password);
      window.location.assign("/login");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete your account?"
      actions={[
        { label: "Delete account", tone: "danger", busy, disabled: !password, onClick: submit },
      ]}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        <p className="m-0">
          You are signed out and removed from every organization. Organizations where you are the
          only member are deleted with their projects after the restore window.
        </p>
        <Field
          id="delete-account-password"
          label="Your password"
          error={error || null}
          hint="Confirms it is really you."
        >
          <Input
            id="delete-account-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}
