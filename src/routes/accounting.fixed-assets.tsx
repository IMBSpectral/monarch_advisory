import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCan } from "@/components/SessionContext";
import { fetchFixedAssets, fetchAssetAccounts, createFixedAssetFn, runDepreciationFn, disposeFixedAssetFn } from "@/api/assets";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/accounting/fixed-assets")({
  loader: async () => {
    const [assets, accounts] = await Promise.all([fetchFixedAssets(), fetchAssetAccounts()]);
    return { assets, accounts };
  },
  component: FixedAssets,
});

type Accounts = { fixedAsset: { id: string; name: string }[]; cash: { id: string; name: string }[]; gainLoss: { id: string; name: string }[] };
const toMinor = (r: string) => String(Math.round(Number(r) * 100));

function FixedAssets() {
  const { assets, accounts } = Route.useLoaderData();
  const router = useRouter();
  const canPost = useCan("ledger:post");
  const [busy, setBusy] = useState(false);

  async function depreciate() {
    setBusy(true);
    try {
      const r = await runDepreciationFn();
      toast.success(r.monthsPosted ? `Posted ${r.monthsPosted} depreciation charge(s)` : "Nothing new to depreciate");
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run depreciation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Fixed Assets"
        subtitle="Asset register, depreciation and disposals"
        actions={
          canPost ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={depreciate} disabled={busy}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
                Run depreciation
              </Button>
              <NewAsset accounts={accounts} />
            </div>
          ) : undefined
        }
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Acquired</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Accum. dep.</TableHead>
                <TableHead className="text-right">Net book value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    No fixed assets registered.
                  </TableCell>
                </TableRow>
              ) : (
                assets.map((a) => (
                  <TableRow key={a.id} className="hover:bg-muted/40">
                    <TableCell className="font-mono text-xs">{a.code}</TableCell>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.acquisitionDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMinor(a.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatMinor(a.accumulated)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMinor(a.nbv)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={a.status === "active" ? "border-success/20 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}>
                        {a.status === "active" ? "Active" : "Disposed"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canPost && a.status === "active" ? (
                        <DisposeAsset asset={a} accounts={accounts} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
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

function NewAsset({ accounts }: { accounts: Accounts }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ code: "", name: "", assetAccountId: "", fundingAccountId: "", cost: "", salvage: "0", life: "36", date: new Date().toISOString().slice(0, 10) });
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!f.code || !f.name || !f.assetAccountId) return setError("Code, name and asset account are required.");
    if (!(Number(f.cost) > 0)) return setError("Enter a positive cost.");
    setPending(true);
    try {
      await createFixedAssetFn({
        data: {
          code: f.code.trim(),
          name: f.name.trim(),
          assetAccountId: f.assetAccountId,
          acquisitionDate: f.date,
          costMinor: toMinor(f.cost),
          salvageValueMinor: toMinor(f.salvage || "0"),
          usefulLifeMonths: Number(f.life),
          fundingAccountId: f.fundingAccountId || null,
        },
      });
      setOpen(false);
      toast.success(`Asset ${f.code} registered`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register the asset.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand text-white"><Plus className="mr-1.5 h-4 w-4" />New Asset</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Register a fixed asset</DialogTitle>
            <DialogDescription>Straight-line depreciation over the useful life.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-4">
            <div className="grid gap-2"><Label>Code</Label><Input value={f.code} onChange={(e) => set({ code: e.target.value })} placeholder="FA-001" /></div>
            <div className="grid gap-2"><Label>Name</Label><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></div>
            <div className="grid gap-2 col-span-2">
              <Label>Asset account</Label>
              <Select value={f.assetAccountId} onValueChange={(v) => set({ assetAccountId: v })}>
                <SelectTrigger><SelectValue placeholder="Fixed-asset account" /></SelectTrigger>
                <SelectContent>{accounts.fixedAsset.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-2"><Label>Cost (₹)</Label><Input type="number" step="any" value={f.cost} onChange={(e) => set({ cost: e.target.value })} /></div>
            <div className="grid gap-2"><Label>Salvage (₹)</Label><Input type="number" step="any" value={f.salvage} onChange={(e) => set({ salvage: e.target.value })} /></div>
            <div className="grid gap-2"><Label>Life (months)</Label><Input type="number" value={f.life} onChange={(e) => set({ life: e.target.value })} /></div>
            <div className="grid gap-2"><Label>Acquired</Label><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></div>
            <div className="grid gap-2 col-span-2">
              <Label>Paid from (optional)</Label>
              <Select value={f.fundingAccountId} onValueChange={(v) => set({ fundingAccountId: v })}>
                <SelectTrigger><SelectValue placeholder="Bank / cash account" /></SelectTrigger>
                <SelectContent>{accounts.cash.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? <><Loader2 className="mr-2 size-4 animate-spin" />Saving…</> : "Register asset"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DisposeAsset({ asset, accounts }: { asset: { id: string; name: string; nbv: string }; accounts: Accounts }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proceeds, setProceeds] = useState("");
  const [cashId, setCashId] = useState("");
  const [glId, setGlId] = useState(accounts.gainLoss[0]?.id ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!glId) return setError("Choose a gain/loss account.");
    if (Number(proceeds) > 0 && !cashId) return setError("Choose where proceeds are received.");
    setPending(true);
    try {
      const r = await disposeFixedAssetFn({
        data: {
          fixedAssetId: asset.id,
          disposalDate: new Date().toISOString().slice(0, 10),
          proceedsMinor: toMinor(proceeds || "0"),
          proceedsAccountId: cashId || null,
          gainLossAccountId: glId,
        },
      });
      setOpen(false);
      const gl = BigInt(r.gainLoss);
      toast.success(`Disposed — ${gl >= 0n ? "gain" : "loss"} ${formatMinor(gl < 0n ? -gl : gl)}`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not dispose the asset.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Dispose</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Dispose {asset.name}</DialogTitle>
            <DialogDescription>Net book value {formatMinor(asset.nbv)}. Proceeds above it book a gain, below a loss.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2"><Label>Proceeds (₹)</Label><Input type="number" step="any" value={proceeds} onChange={(e) => setProceeds(e.target.value)} placeholder="0 = scrapped" /></div>
            <div className="grid gap-2">
              <Label>Received into</Label>
              <Select value={cashId} onValueChange={setCashId}>
                <SelectTrigger><SelectValue placeholder="Bank / cash" /></SelectTrigger>
                <SelectContent>{accounts.cash.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Gain/loss account</Label>
              <Select value={glId} onValueChange={setGlId}>
                <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
                <SelectContent>{accounts.gainLoss.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? <><Loader2 className="mr-2 size-4 animate-spin" />Posting…</> : "Dispose asset"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
