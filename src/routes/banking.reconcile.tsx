/**
 * Bank reconciliation — the real, persistent version.
 *
 * Each unreconciled bank-feed line is proven against the books in one of two
 * ways, both of which write to the database and survive a reload:
 *
 *   • MATCH it to a payment we already recorded — links the two, posts nothing
 *     new (the payment already moved the cash).
 *   • CATEGORIZE a bank-only line (interest, charges) to an income/expense
 *     account — posts a real journal entry against the bank's GL cash account.
 *
 * The summary proves the point of reconciliation: the balance the bank reports
 * (feed) against the balance the books carry (GL), and the gap between them.
 */
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, CheckCircle2, Loader2, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCan } from "@/components/SessionContext";
import { formatMinor, formatMinorSigned } from "@/lib/money";
import { useIdempotencyKey } from "@/lib/idempotency";
import {
  fetchReconciliation,
  reconcileCategorizeFn,
  reconcileExcludeFn,
  reconcileMatchFn,
  unreconcileFn,
} from "@/api/banking";
import { fetchBankSummary } from "@/api/entities";

type RecoData = Awaited<ReturnType<typeof fetchReconciliation>>;

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export const Route = createFileRoute("/banking/reconcile")({
  loader: async () => {
    const accounts = await fetchBankSummary();
    const first = accounts[0]?.id ?? null;
    const initialData = first
      ? await fetchReconciliation({ data: { bankAccountId: first } })
      : null;
    return { accounts, initialAccountId: first, initialData };
  },
  component: Reconcile,
});

function Reconcile() {
  const { accounts, initialAccountId, initialData } = Route.useLoaderData();
  const router = useRouter();
  const canReconcile = useCan("bank:reconcile");
  const idem = useIdempotencyKey();

  const [accountId, setAccountId] = useState<string | null>(initialAccountId);
  const [data, setData] = useState<RecoData | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [catChoice, setCatChoice] = useState<Record<string, string>>({});

  async function reload(id: string) {
    setLoading(true);
    try {
      setData(await fetchReconciliation({ data: { bankAccountId: id } }));
    } catch (e) {
      toast.error(msg(e));
    } finally {
      setLoading(false);
    }
  }

  async function switchAccount(id: string) {
    setAccountId(id);
    await reload(id);
  }

  /** Payments that could back a feed line: same absolute amount and direction. */
  function eligiblePayments(txnAmountMinor: string) {
    if (!data) return [];
    const amt = BigInt(txnAmountMinor);
    const abs = amt < 0n ? -amt : amt;
    const wantDir = amt > 0n ? "inbound" : "outbound";
    return data.candidatePayments.filter(
      (p) => p.direction === wantDir && BigInt(p.amountMinor) === abs,
    );
  }

  async function run(txnId: string, work: () => Promise<void>, done: string) {
    setBusyId(txnId);
    try {
      await work();
      toast.success(done);
      if (accountId) await reload(accountId);
      await router.invalidate();
    } catch (e) {
      toast.error(msg(e));
    } finally {
      setBusyId(null);
    }
  }

  const doMatch = (txnId: string, paymentId: string) =>
    run(
      txnId,
      async () => {
        await reconcileMatchFn({
          data: { bankTransactionId: txnId, paymentId, idempotencyKey: idem.key },
        });
        idem.renew();
      },
      "Matched to payment · reconciled",
    );

  const doCategorize = (txnId: string) => {
    const categoryAccountId = catChoice[txnId];
    if (!categoryAccountId) {
      toast.error("Pick a category first.");
      return;
    }
    return run(
      txnId,
      async () => {
        await reconcileCategorizeFn({
          data: { bankTransactionId: txnId, categoryAccountId, idempotencyKey: idem.key },
        });
        idem.renew();
      },
      "Categorized · journal posted",
    );
  };

  const doExclude = (txnId: string) =>
    run(
      txnId,
      () => reconcileExcludeFn({ data: { bankTransactionId: txnId } }).then(() => {}),
      "Excluded from reconciliation",
    );

  const doUnreconcile = (txnId: string) =>
    run(
      txnId,
      () =>
        unreconcileFn({
          data: { bankTransactionId: txnId, reason: "Undone from reconciliation workspace" },
        }).then(() => {}),
      "Reconciliation undone",
    );

  if (accounts.length === 0) {
    return (
      <>
        <PageHeader title="Reconcile" subtitle="Prove your bank feed against the books" />
        <Card className="mx-6 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No bank accounts yet. Add one in Banking, then import a statement to reconcile.
          </p>
          <Button asChild className="mt-4">
            <Link to="/banking">Go to Banking</Link>
          </Button>
        </Card>
      </>
    );
  }

  const summary = data?.summary;

  return (
    <>
      <PageHeader
        title="Reconcile"
        subtitle="Prove your bank feed against the books"
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/banking/import">
                <Upload className="mr-1.5 h-4 w-4" /> Import statement
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/banking">
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Banking
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-6 p-6">
        {/* Account picker + reconciliation summary */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
          <Card className="w-full p-4 lg:w-72">
            <p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Account</p>
            <Select value={accountId ?? undefined} onValueChange={switchAccount}>
              <SelectTrigger>
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.unreconciledCount > 0 ? ` · ${a.unreconciledCount} to do` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Card>

          {summary ? (
            <Card className="grid flex-1 grid-cols-2 gap-4 p-4 md:grid-cols-4">
              <Metric label="Bank feed balance" value={formatMinor(summary.feedBalanceMinor)} />
              <Metric label="Book (GL) balance" value={formatMinor(summary.glBalanceMinor)} />
              <Metric
                label="Difference"
                value={formatMinorSigned(summary.differenceMinor)}
                muted={summary.differenceMinor === "0"}
                warn={summary.differenceMinor !== "0"}
              />
              <Metric label="Unreconciled" value={String(summary.unreconciledCount)} />
            </Card>
          ) : (
            <Card className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </Card>
          )}
        </div>

        {loading || !data ? null : (
          <>
            {/* To reconcile */}
            <div>
              <h2 className="mb-3 text-sm font-semibold">
                To reconcile{" "}
                <Badge variant="secondary" className="ml-1">
                  {data.unreconciled.length}
                </Badge>
              </h2>
              {data.unreconciled.length === 0 ? (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
                  All caught up — every feed line on this account is reconciled.
                </Card>
              ) : (
                <div className="space-y-2">
                  {data.unreconciled.map((t) => {
                    const eligible = eligiblePayments(t.amountMinor);
                    const inflow = BigInt(t.amountMinor) > 0n;
                    const busy = busyId === t.id;
                    return (
                      <Card key={t.id} className="p-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{t.description}</p>
                            <p className="text-xs text-muted-foreground">{t.date}</p>
                          </div>
                          <div
                            className={`text-sm font-semibold tabular-nums ${
                              inflow ? "text-emerald-600" : "text-foreground"
                            }`}
                          >
                            {formatMinorSigned(t.amountMinor)}
                          </div>
                        </div>

                        {canReconcile ? (
                          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                            {/* Match to an existing payment */}
                            {eligible.length > 0 ? (
                              eligible.slice(0, 3).map((p) => (
                                <Button
                                  key={p.id}
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => doMatch(t.id, p.id)}
                                >
                                  {busy ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  ) : null}
                                  Match {p.paymentNumber}
                                </Button>
                              ))
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                No matching payment —
                              </span>
                            )}

                            {/* Categorize a bank-only line */}
                            <div className="flex items-center gap-1.5">
                              <Select
                                value={catChoice[t.id] ?? ""}
                                onValueChange={(v) => setCatChoice((c) => ({ ...c, [t.id]: v }))}
                              >
                                <SelectTrigger className="h-8 w-56">
                                  <SelectValue
                                    placeholder={
                                      inflow ? "Categorize as income…" : "Categorize as expense…"
                                    }
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {data.categoryAccounts.map((c) => (
                                    <SelectItem key={c.id} value={c.id}>
                                      {c.code} · {c.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                disabled={busy || !catChoice[t.id]}
                                onClick={() => doCategorize(t.id)}
                              >
                                Post
                              </Button>
                            </div>

                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-auto text-muted-foreground"
                              disabled={busy}
                              onClick={() => doExclude(t.id)}
                            >
                              Exclude
                            </Button>
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Your role can’t reconcile transactions.
                          </p>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Reconciled */}
            {data.reconciled.length > 0 ? (
              <div>
                <h2 className="mb-3 text-sm font-semibold">
                  Reconciled{" "}
                  <Badge variant="secondary" className="ml-1">
                    {data.reconciled.length}
                  </Badge>
                </h2>
                <div className="space-y-2">
                  {data.reconciled.map((t) => {
                    const busy = busyId === t.id;
                    return (
                      <Card key={t.id} className="flex items-center gap-3 p-3">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{t.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {t.date} ·{" "}
                            {t.status === "excluded"
                              ? "Excluded"
                              : t.kind === "match"
                                ? "Matched to payment"
                                : "Categorized"}
                          </p>
                        </div>
                        <span className="text-sm font-semibold tabular-nums">
                          {formatMinorSigned(t.amountMinor)}
                        </span>
                        {canReconcile ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => doUnreconcile(t.id)}
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            <span className="ml-1 hidden sm:inline">Undo</span>
                          </Button>
                        ) : null}
                      </Card>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  muted,
  warn,
}: {
  label: string;
  value: string;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${
          warn ? "text-amber-600" : muted ? "text-muted-foreground" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}
