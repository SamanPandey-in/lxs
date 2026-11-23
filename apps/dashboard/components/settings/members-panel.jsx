"use client";
import { MailPlus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  Select,
  TableSkeleton,
} from "@/components/ui";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { resolveProject } from "@/lib/core";
import { identity, ROLE_HELP, ROLE_LABELS, useMe } from "@/lib/identity";
import { toast } from "@/lib/toast";

const ROLE_OPTIONS = ["owner", "analyst", "viewer"].map((r) => ({
  value: r,
  label: ROLE_LABELS[r],
}));
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : "—");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Settings → Members: who is in this project's organization, their roles, and pending
 * invitations. Owners invite, change roles and remove; everyone else can leave.
 * The API enforces all of it (and never removes or demotes the last owner); the UI
 * only mirrors those rules so the reason is visible before a click.
 */
export default function MembersPanel() {
  const titleId = useId();
  const me = useMe();
  const [orgId, setOrgId] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      let oid = orgId;
      if (!oid) {
        const project = await identity.project(await resolveProject());
        oid = project.org_id;
        setOrgId(oid);
      }
      setData(await identity.members(oid));
    } catch (err) {
      setError(err);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const isOwner = data?.my_role === "owner";
  const owners = (data?.members || []).filter((m) => m.role === "owner").length;
  const unverified = me?.email_verified === false;
  const inviteBlocked = !isOwner
    ? "Only owners can invite people."
    : unverified
      ? "Confirm your email address first (see the banner)."
      : null;

  const changeRole = async (m, role) => {
    if (role === m.role) return;
    setBusy(`role:${m.user_id}`);
    try {
      await identity.changeRole(orgId, m.user_id, role);
      toast(
        `${m.name || m.email} is now ${ROLE_LABELS[role].toLowerCase()}`,
        "success",
        "Logged to audit.",
      );
      await load();
    } catch (err) {
      toast("Could not change the role", "error", err.message);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    const m = removing;
    if (!m) return;
    setBusy(`remove:${m.user_id}`);
    try {
      await identity.removeMember(orgId, m.user_id);
      setRemoving(null);
      if (m.user_id === me?.id) {
        window.location.assign("/dashboard");
        return;
      }
      toast(`Removed ${m.name || m.email}`, "warning", "Logged to audit.");
      await load();
    } catch (err) {
      toast("Could not remove the member", "error", err.message);
    } finally {
      setBusy("");
    }
  };

  const revoke = async (inv) => {
    setBusy(`revoke:${inv.id}`);
    try {
      await identity.revokeInvite(orgId, inv.id);
      toast(`Invitation for ${inv.email} withdrawn`, "warning");
      await load();
    } catch (err) {
      toast("Could not withdraw the invitation", "error", err.message);
    } finally {
      setBusy("");
    }
  };

  const lastOwnerReason = (m) =>
    m.role === "owner" && owners <= 1 ? "An organization needs at least one owner." : null;

  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={titleId} className="m-0 text-lg font-semibold text-foreground">
            Members
          </h2>
          <p className="m-0 mt-0.5 max-w-[70ch] text-sm text-muted-foreground">
            People in {data?.org?.name || "this organization"}. Owners manage keys, settings and
            members; analysts work incidents; viewers read.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setInviteOpen(true)}
          disabledReason={data ? inviteBlocked : "Loading members"}
        >
          <MailPlus aria-hidden /> Invite
        </Button>
      </div>

      <Card flush>
        {error && !data ? (
          <ErrorState error={error} onRetry={load} what="members" />
        ) : !data ? (
          <TableSkeleton rows={3} cols={4} />
        ) : data.members.length === 0 ? (
          <EmptyState icon={Users} title="No members">
            Invite your team to share incidents.
          </EmptyState>
        ) : (
          <Table inset>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Member</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col">Joined</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => {
                const self = m.user_id === me?.id;
                const lastOwner = lastOwnerReason(m);
                return (
                  <TableRow key={m.user_id} className="h-11">
                    <TableCell>
                      <span className="flex min-w-0 flex-col">
                        <span className="inline-flex items-center gap-2 font-medium text-foreground">
                          <span className="max-w-[28ch] truncate" title={m.name || m.email}>
                            {m.name || m.username || m.email}
                          </span>
                          {self ? (
                            <Badge variant="tag" tone="neutral">
                              You
                            </Badge>
                          ) : null}
                          {m.email_verified ? null : (
                            <Badge variant="tag" tone="warn" title="Email not confirmed yet">
                              Unverified
                            </Badge>
                          )}
                        </span>
                        <span
                          className="max-w-[36ch] truncate text-xs text-muted-foreground"
                          title={m.email}
                        >
                          {m.email}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {isOwner && !lastOwner ? (
                        <Select
                          size="sm"
                          value={m.role}
                          options={ROLE_OPTIONS}
                          disabled={busy === `role:${m.user_id}`}
                          onValueChange={(v) => changeRole(m, v)}
                          aria-label={`Role for ${m.name || m.email}`}
                        />
                      ) : (
                        <span
                          className="text-sm text-foreground"
                          title={lastOwner || ROLE_HELP[m.role]}
                        >
                          {ROLE_LABELS[m.role] || m.role}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                      {fmtDate(m.joined_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isOwner || self ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRemoving(m)}
                          disabledReason={lastOwner}
                          aria-label={self ? "Leave organization" : `Remove ${m.name || m.email}`}
                        >
                          <Trash2 aria-hidden /> {self ? "Leave" : "Remove"}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {isOwner && data?.invites?.length ? (
        <Card flush>
          <Table inset>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Pending invitation</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col">Expires</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.invites.map((inv) => (
                <TableRow key={inv.id} className="h-11">
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <span className="max-w-[36ch] truncate text-foreground" title={inv.email}>
                        {inv.email}
                      </span>
                      {inv.status === "expired" ? (
                        <Badge variant="tag" tone="warn">
                          Expired
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{ROLE_LABELS[inv.role] || inv.role}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                    {fmtDate(inv.expires_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === `revoke:${inv.id}`}
                      onClick={() => revoke(inv)}
                    >
                      Withdraw
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}

      <InviteModal
        open={inviteOpen}
        orgName={data?.org?.name}
        onClose={() => setInviteOpen(false)}
        onInvite={async (email, role) => {
          await identity.invite(orgId, email, role);
          toast(`Invitation sent to ${email}`, "success", "The link expires in 7 days.");
          setInviteOpen(false);
          await load();
        }}
      />

      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={
          removing?.user_id === me?.id
            ? "Leave this organization?"
            : `Remove ${removing?.name || removing?.email || "member"}?`
        }
        actions={[
          {
            label: removing?.user_id === me?.id ? "Leave" : "Remove",
            tone: "danger",
            busy: busy.startsWith("remove:"),
            onClick: remove,
          },
        ]}
      >
        <p className="m-0">
          {removing?.user_id === me?.id
            ? "You lose access to its projects right away. An owner can invite you back."
            : "They lose access to every project in this organization right away. You can invite them again later."}
        </p>
      </Modal>
    </section>
  );
}

function InviteModal({ open, orgName, onClose, onInvite }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("analyst");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = EMAIL_RE.test(email.trim());

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setRole("analyst");
    setTouched(false);
    setError("");
  }, [open]);

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      await onInvite(email.trim(), role);
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
      title={`Invite to ${orgName || "this organization"}`}
      actions={[{ label: "Send invitation", busy, disabled: touched && !valid, onClick: submit }]}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        <Field
          id="invite-email"
          label="Email address"
          error={touched && !valid ? "Enter a valid email address." : error || null}
          hint="They get a link to join. It works once and expires in 7 days."
        >
          <Input
            id="invite-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(Boolean(email))}
            placeholder="teammate@company.com"
          />
        </Field>
        <Field id="invite-role" label="Role" hint={ROLE_HELP[role]}>
          <Select id="invite-role" value={role} options={ROLE_OPTIONS} onValueChange={setRole} />
        </Field>
      </form>
    </Modal>
  );
}
