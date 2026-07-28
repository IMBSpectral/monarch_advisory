import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useCan } from "@/components/SessionContext";
import { fetchExchangeRates, upsertExchangeRateFn } from "@/api/forex";

export const Route = createFileRoute("/accounting/exchange-rates")({
  loader: async () => fetchExchangeRates(),
  component: ExchangeRatesPage,
});

function ExchangeRatesPage() {
  const rates = Route.useLoaderData();
  const canManage = useCan("settings:manage");
  return (
    <>
      <PageHeader
        title="Exchange Rates"
        subtitle="Foreign-currency rates to your base currency (INR)"
        actions={canManage ? <NewRate /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Currency</TableHead>
                <TableHead className="text-right">Rate to INR</TableHead>
                <TableHead>As of</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    No exchange rates yet.
                  </TableCell>
                </TableRow>
              ) : (
                rates.map((r) => (
                  <TableRow key={r.id} className="hover:bg-muted/40">
                    <TableCell className="font-medium">{r.currencyCode}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      ₹{Number(r.rateToBase).toFixed(4)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.asOfDate}</TableCell>
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

function NewRate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ccy, setCcy] = useState("");
  const [rate, setRate] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (ccy.trim().length !== 3) return setError("Use a 3-letter currency code, e.g. USD.");
    if (!(Number(rate) > 0)) return setError("Enter a positive rate.");
    setPending(true);
    try {
      await upsertExchangeRateFn({
        data: { currencyCode: ccy.trim().toUpperCase(), rateToBase: rate, asOfDate: date },
      });
      setOpen(false);
      setCcy("");
      setRate("");
      toast.success(`${ccy.toUpperCase()} rate saved`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the rate.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          Add Rate
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add exchange rate</DialogTitle>
            <DialogDescription>How many rupees one unit of the currency buys.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="fx-ccy">Currency</Label>
              <Input
                id="fx-ccy"
                value={ccy}
                onChange={(e) => setCcy(e.target.value)}
                placeholder="USD"
                maxLength={3}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fx-rate">Rate (₹)</Label>
              <Input
                id="fx-rate"
                type="number"
                step="any"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="83.50"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fx-date">As of</Label>
              <Input
                id="fx-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>
          {error ? (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save rate"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
