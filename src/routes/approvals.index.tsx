/**
 * The maker-checker approval queue. Payments and manual journals at or above the
 * org's approval threshold land here instead of posting; a different user approves
 * (which replays the operation with their identity) or rejects with a reason.
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCircle2, Clock, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useCan } from "@/components/SessionContext";
import { fetchPendingApprovals, approvePendingFn, rejectPendingFn } from "@/api/approvals";
import { formatMinor } from "@/lib/money";

type Pending = Awaited<ReturnType<typeof fetchPendingApprovals>>[number];

const OPERATION_LABEL: Record<string, string> = {
  "payment.customer": "Customer payment",
  "payment.vendor": "Vendor payment",
  "journal.manual": "Manual journal",
};

export const Route = createFileRoute("/approvals/")({
  loader: async () => ({ pending: await fetchPendingApprovals() }),
  component: Approvals,
});

function Approvals() {
  const { pending } = Route.useLoaderData();
  const router = useRouter();
  const canRecordPayment = useCan("payment:record");
  const canPostLedger = useCan("ledger:post");
  const canApprove = canRecordPayment || canPostLedger;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function approve(item: Pending) {
    setBusyId(item.id);
    try {
      await approvePendingFn({ data: { pendingId: item.id } });
      toast.success("Approved and posted.");
      await router.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve.");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(item: Pending) {
    if (!reason.trim()) {
      toast.error("A reason is required to reject.");
      return;
    }
    setBusyId(item.id);
    try {
      await rejectPendingFn({ data: { pendingId: item.id, reason: reason.trim() } });
      toast.success("Rejected.");
      setRejecting(null);
      setReason("");
      await router.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reject.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Payments and journals waiting for a second person to approve"
      />
      <div className="p-6">
        {pending.length === 0 ? (
          <Card className="p-10 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
            Nothing waiting for approval.
          </Card>
        ) : (
          <div className="space-y-2">
            {pending.map((item) => {
              const busy = busyId === item.id;
              return (
                <Card key={item.id} className="p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          {OPERATION_LABEL[item.operation] ?? item.operation}
                        </Badge>
                        <span className="text-sm font-medium">{item.summary}</span>
                      </div>
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Requested by {item.requestedByName ?? "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold tabular-nums">
                        {formatMinor(item.amountMinor)}
                      </span>
                      {canApprove ? (
                        <div className="flex items-center gap-2">
                          <Button size="sm" disabled={busy} onClick={() => approve(item)}>
                            {busy ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              setRejecting(rejecting === item.id ? null : item.id);
                              setReason("");
                            }}
                          >
                            <X className="mr-1.5 h-3.5 w-3.5" />
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {rejecting === item.id ? (
                    <div className="mt-3 flex items-center gap-2 border-t pt-3">
                      <Input
                        autoFocus
                        placeholder="Reason for rejecting (recorded)…"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => reject(item)}
                      >
                        Confirm reject
                      </Button>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
