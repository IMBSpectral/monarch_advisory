import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useCan } from "@/components/SessionContext";
import {
  fetchImportableBankAccounts,
  importBankStatementFn,
  fetchBankTransactionsFor,
} from "@/api/banking";
import { formatMinorSigned } from "@/lib/money";

export const Route = createFileRoute("/banking/import")({
  loader: async () => {
    const [accounts, transactions] = await Promise.all([
      fetchImportableBankAccounts(),
      fetchBankTransactionsFor({ data: undefined }),
    ]);
    return { accounts, transactions };
  },
  component: BankImport,
});

/** Parse "date,description,amount" lines (amount in rupees, signed). */
function parseCsv(
  text: string,
): { transactionDate: string; description: string; amountMinor: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^date\s*,/i.test(l))
    .map((l) => {
      const parts = l.split(",");
      const date = parts[0]?.trim();
      const amount = parts[parts.length - 1]?.trim();
      const description = parts.slice(1, -1).join(",").trim();
      return {
        transactionDate: date,
        description,
        amountMinor: String(Math.round(Number(amount) * 100)),
      };
    })
    .filter(
      (r) =>
        /^\d{4}-\d{2}-\d{2}$/.test(r.transactionDate) &&
        r.description &&
        Number.isFinite(Number(r.amountMinor)) &&
        Number(r.amountMinor) !== 0,
    );
}

const SAMPLE = `2026-07-02,UPI/ZOMATO/settlement,89400\n2026-07-05,NEFT/AWS/invoice 4516,-184000\n2026-07-08,Bank charges,-250.50`;

function BankImport() {
  const { accounts, transactions } = Route.useLoaderData();
  const router = useRouter();
  const canImport = useCan("bank:reconcile");
  const [accountId, setAccountId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseCsv(text), [text]);

  async function doImport() {
    if (!accountId) return toast.error("Choose a bank account.");
    if (parsed.length === 0) return toast.error("No valid rows to import.");
    setBusy(true);
    try {
      const r = await importBankStatementFn({ data: { bankAccountId: accountId, rows: parsed } });
      toast.success(
        `Imported ${r.imported} transaction(s)${r.skipped ? `, ${r.skipped} duplicate(s) skipped` : ""}`,
      );
      setText("");
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Import Bank Statement"
        subtitle="Paste statement rows (date, description, amount) to bring them into reconciliation"
      />
      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <Card className="p-5">
          <div className="grid gap-2">
            <Label>Bank account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-4 grid gap-2">
            <Label>Statement rows (CSV)</Label>
            <textarea
              className="min-h-40 w-full rounded-md border bg-background p-3 font-mono text-xs"
              placeholder={SAMPLE}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="text-xs text-brand underline"
                onClick={() => setText(SAMPLE)}
              >
                Load sample
              </button>
              <span className="text-xs text-muted-foreground">{parsed.length} valid row(s)</span>
            </div>
          </div>
          {canImport ? (
            <Button
              className="mt-4 w-full"
              onClick={doImport}
              disabled={busy || parsed.length === 0}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Import {parsed.length || ""} rows
            </Button>
          ) : null}
        </Card>

        <Card>
          <div className="border-b p-4 text-sm font-medium">Recent imported transactions</div>
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
              {transactions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No transactions imported yet.
                  </TableCell>
                </TableRow>
              ) : (
                transactions.map((t) => (
                  <TableRow key={t.id} className="hover:bg-muted/40">
                    <TableCell className="text-muted-foreground">{t.date}</TableCell>
                    <TableCell className="max-w-xs truncate">{t.description}</TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${BigInt(t.amount) < 0n ? "text-destructive" : "text-success"}`}
                    >
                      {formatMinorSigned(t.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
