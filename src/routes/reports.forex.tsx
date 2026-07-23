import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCan } from "@/components/SessionContext";
import { fetchForexExposure, postForexRevaluationFn } from "@/api/forex";
import { formatMinor, formatMinorSigned } from "@/lib/money";

export const Route = createFileRoute("/reports/forex")({
  loader: async () => fetchForexExposure(),
  component: Forex,
});

const fx = (minor: string, code: string) => {
  const n = Number(minor) / 100;
  return `${code} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function Forex() {
  const ex = Route.useLoaderData();
  const router = useRouter();
  const canPost = useCan("ledger:post");
  const [busy, setBusy] = useState(false);
  const hasMovement = ex.rows.some((r) => BigInt(r.unrealized) !== 0n);

  async function revalue() {
    setBusy(true);
    try {
      const r = await postForexRevaluationFn();
      toast.success(`Revaluation ${r.entryNumber} posted`);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not post revaluation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Forex Revaluation"
        subtitle="Unrealised gain / loss on foreign-currency accounts"
        actions={
          canPost ? (
            <Button size="sm" className="bg-gradient-brand text-white" disabled={busy || !hasMovement} onClick={revalue}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Post revaluation
            </Button>
          ) : undefined
        }
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Foreign balance</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Base carrying</TableHead>
                <TableHead className="text-right">Revalued</TableHead>
                <TableHead className="text-right">Unrealised</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ex.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No foreign-currency accounts.
                  </TableCell>
                </TableRow>
              ) : (
                ex.rows.map((r) => (
                  <TableRow key={r.code} className="hover:bg-muted/40">
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{fx(r.foreignBalance, r.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">₹{r.rate?.toFixed(4) ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(r.baseCarrying)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(r.revalued)}</TableCell>
                    <TableCell className={`text-right font-medium tabular-nums ${BigInt(r.unrealized) < 0n ? "text-destructive" : "text-success"}`}>
                      {formatMinorSigned(r.unrealized)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {ex.rows.length > 0 ? (
              <tfoot>
                <TableRow className="border-t-2 font-semibold">
                  <TableCell colSpan={5}>Total unrealised {BigInt(ex.totalUnrealized) < 0n ? "loss" : "gain"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMinorSigned(ex.totalUnrealized)}</TableCell>
                </TableRow>
              </tfoot>
            ) : null}
          </Table>
          {!hasMovement && ex.rows.length > 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Carrying values already match today's rates — nothing to revalue.
            </p>
          ) : null}
        </Card>
      </div>
    </>
  );
}
