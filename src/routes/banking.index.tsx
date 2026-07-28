import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Landmark, Plus, Sparkles } from "lucide-react";
import { EntityFormDialog } from "@/components/EntityFormDialog";
import { useCan } from "@/components/SessionContext";
import { fetchBankSummary, fetchBankTransactions } from "@/api/entities";
import { createBankAccountFn } from "@/api";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/banking/")({
  loader: async () => {
    const [accounts, txns] = await Promise.all([
      fetchBankSummary(),
      fetchBankTransactions({ data: { limit: 50 } }),
    ]);
    return { accounts, txns };
  },
  component: Banking,
});

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "matched" || s === "reconciled") {
    return (
      <Badge variant="outline" className="bg-success/10 text-success border-success/20">
        {status}
      </Badge>
    );
  }
  if (s === "suggested" || s === "pending") {
    return (
      <Badge variant="outline" className="bg-warning/10 text-warning-foreground border-warning/30">
        {status}
      </Badge>
    );
  }
  return <Badge variant="outline">{status}</Badge>;
}

function Banking() {
  const { accounts, txns } = Route.useLoaderData();
  const canManage = useCan("bank:manage");

  function autoReconcile() {
    toast.info(
      "Automated reconciliation matching runs against the bank feed; connect a live feed to enable.",
    );
  }

  return (
    <>
      <PageHeader
        title="Banking"
        subtitle="Accounts, transactions, and AI reconciliation"
        actions={canManage ? <AddBankAccountButton /> : undefined}
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {accounts.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground md:col-span-3">
              No bank accounts yet. Add one manually, or connect a feed to see balances here.
            </Card>
          ) : (
            accounts.map((a) => (
              <Card key={a.id} className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-brand">
                    <Landmark className="h-5 w-5 text-white" />
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {a.accountNumberMasked}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-3">{a.name}</p>
                <p className="text-[11px] text-muted-foreground">{a.institutionName}</p>
                <p className="text-2xl font-semibold tabular-nums mt-1">
                  {formatMinor(a.glBalance)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {a.feedBalance != null
                    ? `Bank feed: ${formatMinor(a.feedBalance)}`
                    : "No live feed"}
                </p>
                {a.unreconciledCount > 0 && (
                  <Badge
                    variant="outline"
                    className="mt-2 bg-warning/10 text-warning-foreground border-warning/30 text-[10px]"
                  >
                    {a.unreconciledCount} unreconciled
                  </Badge>
                )}
              </Card>
            ))
          )}
        </div>

        <Card>
          <div className="flex items-center justify-between p-4 border-b">
            <div>
              <h3 className="font-semibold">Recent Transactions</h3>
              <p className="text-xs text-muted-foreground">Latest bank feed activity</p>
            </div>
            <Button size="sm" className="bg-gradient-brand text-white" onClick={autoReconcile}>
              <Sparkles className="h-4 w-4 mr-1.5" />
              Auto-reconcile
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No transactions yet. Connect a bank feed to import activity.
                  </TableCell>
                </TableRow>
              ) : (
                txns.map((t) => {
                  const negative = t.amount.startsWith("-");
                  return (
                    <TableRow key={t.id} className="hover:bg-muted/40">
                      <TableCell className="text-muted-foreground">{t.transactionDate}</TableCell>
                      <TableCell className="font-medium">{t.description}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums font-semibold ${negative ? "text-destructive" : "text-success"}`}
                      >
                        {negative ? "" : "+"}
                        {formatMinor(t.amount)}
                      </TableCell>
                      <TableCell>{statusBadge(t.status)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}

/**
 * "Add account" — create a bank or cash account manually, no live feed needed.
 * This creates both the backing cash_and_bank ledger account (so payments, POS
 * and vouchers can settle into it) and the bank_accounts row shown above.
 * Gated on bank:manage.
 */
function AddBankAccountButton() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"bank" | "cash">("bank");
  const [institution, setInstitution] = useState("");
  const [number, setNumber] = useState("");

  return (
    <EntityFormDialog
      trigger={
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          Add account
        </Button>
      }
      title="Add bank or cash account"
      description="Track a bank or cash account manually — no live feed required."
      submitLabel="Add account"
      successMessage="Account added"
      onSubmit={async () => {
        if (!name.trim()) throw new Error("An account name is required.");
        await createBankAccountFn({
          data: {
            name: name.trim(),
            kind,
            institutionName: kind === "bank" ? institution.trim() || null : null,
            accountNumberMasked: kind === "bank" ? number.trim() || null : null,
          },
        });
        setName("");
        setKind("bank");
        setInstitution("");
        setNumber("");
        await router.invalidate();
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="ba-kind">Type</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as "bank" | "cash")}>
            <SelectTrigger id="ba-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bank">Bank</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ba-name">Name</Label>
          <Input
            id="ba-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "cash" ? "Petty Cash" : "HDFC Current"}
          />
        </div>
      </div>
      {kind === "bank" && (
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ba-inst">Bank name</Label>
            <Input
              id="ba-inst"
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              placeholder="HDFC Bank"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ba-num">Account number</Label>
            <Input
              id="ba-num"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="••••8821"
            />
          </div>
        </div>
      )}
    </EntityFormDialog>
  );
}
