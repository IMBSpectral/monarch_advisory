import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCan } from "@/components/SessionContext";
import { fetchPeriodStatus, closePeriodFn, reopenPeriodFn } from "@/api/period";

export const Route = createFileRoute("/accounting/period-close")({
  loader: async () => fetchPeriodStatus(),
  component: PeriodClose,
});

function PeriodClose() {
  const status = Route.useLoaderData();
  const router = useRouter();
  const canClose = useCan("period:close");
  const [busy, setBusy] = useState(false);
  const [through, setThrough] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function close(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!through) return setError("Choose a date to close through.");
    setBusy(true);
    try {
      const r = await closePeriodFn({ data: { throughDate: through } });
      toast.success(
        `Books closed — net ${r.netProfit} rolled to retained earnings (${r.entryNumber})`,
      );
      setThrough("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close the period.");
    } finally {
      setBusy(false);
    }
  }

  async function reopen(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reason.trim()) return setError("A reason is required to reopen.");
    setBusy(true);
    try {
      await reopenPeriodFn({ data: { reason: reason.trim() } });
      toast.success("Period reopened");
      setReason("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reopen the period.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Period Close"
        subtitle="Freeze a settled period and roll profit into retained earnings"
      />
      <div className="p-6">
        <Card className="mx-auto max-w-xl p-6">
          <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm">
            <span className="font-medium">{status.fiscalYear.label}</span>
            <span className="text-muted-foreground">
              {" "}
              · {status.fiscalYear.start} to {status.fiscalYear.end}
            </span>
          </div>
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Books closed through
              </p>
              <p className="mt-1 text-2xl font-bold">
                {status.closedThrough ?? "Open — never closed"}
              </p>
            </div>
            <Badge
              variant="outline"
              className={
                status.closedThrough
                  ? "border-warning/30 bg-warning/10 text-warning-foreground"
                  : "border-success/20 bg-success/10 text-success"
              }
            >
              {status.closedThrough ? (
                <>
                  <Lock className="mr-1 h-3 w-3" />
                  Locked
                </>
              ) : (
                <>
                  <LockOpen className="mr-1 h-3 w-3" />
                  Open
                </>
              )}
            </Badge>
          </div>

          {canClose ? (
            <div className="space-y-6">
              <form onSubmit={close} className="space-y-3 border-t pt-5">
                <Label htmlFor="pc-through">Close books through</Label>
                <div className="flex gap-2">
                  <Input
                    id="pc-through"
                    type="date"
                    value={through}
                    onChange={(e) => setThrough(e.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Lock className="mr-2 h-4 w-4" />
                    )}
                    Close
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Zeroes every income and expense account into retained earnings and blocks any
                  posting on or before this date.
                </p>
              </form>

              {status.closedThrough ? (
                <form onSubmit={reopen} className="space-y-3 border-t pt-5">
                  <Label htmlFor="pc-reason">Reopen (reason required — audited)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="pc-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why are you reopening?"
                    />
                    <Button type="submit" variant="outline" disabled={busy}>
                      {busy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <LockOpen className="mr-2 h-4 w-4" />
                      )}
                      Reopen
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : (
            <p className="border-t pt-5 text-sm text-muted-foreground">
              Closing the books requires the admin role.
            </p>
          )}

          {error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </Card>
      </div>
    </>
  );
}
