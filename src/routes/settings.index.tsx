import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Building2, ShieldCheck, Shield, Receipt, UserPlus } from "lucide-react";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityFormDialog } from "@/components/EntityFormDialog";
import { useCan, useSession, type Role } from "@/components/SessionContext";
import { fetchMe, fetchMembersFn, addMemberFn, changeMemberRoleFn } from "@/api/auth";
import { fetchApprovalSettings, updateApprovalThresholdFn } from "@/api/settings";
import { formatMinor } from "@/lib/money";

const ROLE_OPTIONS: Role[] = ["viewer", "staff", "accountant", "admin", "owner"];

export const Route = createFileRoute("/settings/")({
  // fetchMembersFn requires "member:manage" and throws for viewers/staff, so we
  // only call it once we know the current user's role permits it.
  loader: async () => {
    const me = await fetchMe();
    const canManage = me ? ["admin", "owner"].includes(me.role) : false;
    const members = canManage ? await fetchMembersFn() : [];
    const approval = await fetchApprovalSettings();
    return { me, members, canManage, approval };
  },
  component: Settings,
});

type Member = Awaited<ReturnType<typeof fetchMembersFn>>[number];

function roleBadgeVariant(role: string): "default" | "secondary" | "outline" {
  if (role === "owner") return "default";
  if (role === "admin") return "secondary";
  return "outline";
}

function Settings() {
  const { members, canManage, approval } = Route.useLoaderData();
  const session = useSession();
  const canInvite = useCan("member:manage");
  const canManageSettings = useCan("settings:manage");

  // The org can never be left ownerless, so we don't offer to demote the last
  // owner — the server would reject it anyway.
  const ownerCount = members.filter((m) => m.role === "owner").length;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Organization, team members, and taxes"
        actions={canInvite ? <InviteMemberButton /> : undefined}
      />
      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Building2 className="h-4 w-4 text-brand" />
            <h3 className="font-semibold">Organization</h3>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">Name</span>
              <span className="font-medium">{session?.orgName ?? "—"}</span>
            </div>
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">Your role</span>
              <span>
                {session ? (
                  <Badge variant={roleBadgeVariant(session.role)} className="capitalize">
                    {session.role}
                  </Badge>
                ) : (
                  "—"
                )}
              </span>
            </div>
            <div className="flex justify-between border-b pb-2">
              <span className="text-muted-foreground">Base Currency</span>
              <span>{session?.baseCurrency ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Signed in as</span>
              <span className="font-medium">{session?.email ?? "—"}</span>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Receipt className="h-4 w-4 text-brand" />
            <h3 className="font-semibold">Tax Rates</h3>
          </div>
          <div className="space-y-2 text-sm">
            {[
              { l: "GST 18% (Standard)", d: "Default output tax" },
              { l: "GST 12%", d: "Reduced rate" },
              { l: "GST 5%", d: "Essential goods" },
              { l: "IGST 18%", d: "Inter-state" },
              { l: "TDS 194J @ 10%", d: "Professional services" },
            ].map((t) => (
              <div
                key={t.l}
                className="flex items-center justify-between py-1.5 border-b last:border-0"
              >
                <div>
                  <p className="font-medium">{t.l}</p>
                  <p className="text-xs text-muted-foreground">{t.d}</p>
                </div>
                <Badge variant="outline" className="bg-success/10 text-success border-success/20">
                  Active
                </Badge>
              </div>
            ))}
          </div>
        </Card>

        <ApprovalsCard
          thresholdMinor={approval.approvalThresholdMinor}
          canManage={canManageSettings}
        />

        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="h-4 w-4 text-brand" />
            <h3 className="font-semibold">Team Members</h3>
          </div>
          {!canManage ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              You need admin access to view and manage team members.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                      No team members yet. Invite someone to collaborate.
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((m) => (
                    <MemberRow
                      key={m.userId}
                      member={m}
                      isOnlyOwner={m.role === "owner" && ownerCount === 1}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * Maker-checker approval threshold. A bill at or above this amount must be posted
 * by someone other than the person who created it. Stored in minor units; edited
 * here in whole rupees.
 */
function ApprovalsCard({
  thresholdMinor,
  canManage,
}: {
  thresholdMinor: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [rupees, setRupees] = useState(
    thresholdMinor ? (BigInt(thresholdMinor) / 100n).toString() : "",
  );
  const [saving, setSaving] = useState(false);

  async function save(thresholdMinorValue: string | null) {
    setSaving(true);
    try {
      await updateApprovalThresholdFn({ data: { thresholdMinor: thresholdMinorValue } });
      toast.success(
        thresholdMinorValue
          ? `Approvals on — bills at or above ${formatMinor(thresholdMinorValue, { showPaise: false })} need a second person.`
          : "Approvals off.",
      );
      await router.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="h-4 w-4 text-brand" />
        <h3 className="font-semibold">Approvals (maker-checker)</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        A bill at or above this amount can’t be posted by the person who created it — a different
        user must post it. Leave blank to switch approvals off.
      </p>
      {!canManage ? (
        <p className="mt-4 text-sm">
          {thresholdMinor ? (
            <>
              Current threshold:{" "}
              <span className="font-medium">
                {formatMinor(thresholdMinor, { showPaise: false })}
              </span>
            </>
          ) : (
            "Approvals are off."
          )}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="approval-threshold" className="text-xs">
              Threshold (₹)
            </Label>
            <Input
              id="approval-threshold"
              inputMode="numeric"
              className="mt-1 w-48"
              placeholder="e.g. 50000"
              value={rupees}
              onChange={(e) => setRupees(e.target.value.replace(/[^\d]/g, ""))}
            />
          </div>
          <Button
            disabled={saving}
            onClick={() => save(rupees === "" ? null : `${BigInt(rupees) * 100n}`)}
          >
            Save
          </Button>
          {thresholdMinor ? (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setRupees("");
                save(null);
              }}
            >
              Turn off
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** A single member row, with an inline role changer gated on member:manage. */
function MemberRow({ member, isOnlyOwner }: { member: Member; isOnlyOwner: boolean }) {
  const router = useRouter();
  const canManage = useCan("member:manage");
  const [saving, setSaving] = useState(false);

  async function changeRole(role: string) {
    if (role === member.role) return;
    setSaving(true);
    try {
      await changeMemberRoleFn({ data: { userId: member.userId, role: role as Role } });
      toast.success(`${member.name} is now ${role}`);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change role.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <TableRow className="hover:bg-muted/40">
      <TableCell>
        <div className="flex items-center gap-2.5">
          <div className="bg-gradient-brand flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white">
            {member.name.slice(0, 1)}
          </div>
          <span className="font-medium">{member.name}</span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{member.email}</TableCell>
      <TableCell>
        {canManage && !isOnlyOwner ? (
          <Select value={member.role} onValueChange={changeRole} disabled={saving}>
            <SelectTrigger className="h-8 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((r) => (
                <SelectItem key={r} value={r} className="capitalize">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant={roleBadgeVariant(member.role)} className="capitalize">
            {member.role}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {/*
          Explicit locale + timeZone, not the runtime defaults. `toLocaleDateString()`
          with no args formats using the host's locale and zone, which differ between
          the SSR server and the browser — producing a hydration text mismatch
          (React #418). Pinning both makes server and client render identical text.
        */}
        {new Date(member.joinedAt).toLocaleDateString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          year: "numeric",
        })}
      </TableCell>
    </TableRow>
  );
}

/**
 * "Invite member" — creates a user + membership through `addMemberFn`, then
 * invalidates so the members table re-loads with the new row.
 */
function InviteMemberButton() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [password, setPassword] = useState("");

  return (
    <EntityFormDialog
      trigger={
        <Button size="sm" className="bg-gradient-brand text-white">
          <UserPlus className="mr-1.5 h-4 w-4" />
          Invite member
        </Button>
      }
      title="Invite member"
      description="Add a teammate to this organization."
      submitLabel="Send invite"
      successMessage="Member added"
      onSubmit={async () => {
        await addMemberFn({ data: { email, name, role, password } });
        setName("");
        setEmail("");
        setRole("staff");
        setPassword("");
        await router.invalidate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="mem-name">Name</Label>
        <Input id="mem-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="mem-email">Email</Label>
        <Input
          id="mem-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="mem-role">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="mem-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((r) => (
                <SelectItem key={r} value={r} className="capitalize">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="mem-password">Initial password</Label>
          <Input
            id="mem-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        This sets the member's initial password for new users. Ask them to change it after their
        first sign-in.
      </p>
    </EntityFormDialog>
  );
}
