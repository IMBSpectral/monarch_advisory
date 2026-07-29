/**
 * Bulk CSV import for master data (contacts, items). Paste or upload a CSV,
 * preview the parsed rows, then import — the server validates and creates each
 * row independently, skips duplicates, and returns a per-row error report.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { FileUp, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCan } from "@/components/SessionContext";
import { parseCsv } from "@/lib/csv";
import { importContactsFn, importItemsFn, type ImportResult } from "@/api/import";

export const Route = createFileRoute("/import/")({
  component: ImportPage,
});

type Entity = "contacts" | "items";

const TEMPLATE: Record<Entity, { headers: string; note: string }> = {
  contacts: {
    headers: "name,type,email,phone,gstin,paymentTerms,notes",
    note: "type is customer, vendor, or both. paymentTerms is a number of days.",
  },
  items: {
    headers: "name,sku,salePrice,purchasePrice,tracked,uom,hsn",
    note: "prices in rupees. tracked is yes/no (whether stock is tracked).",
  },
};

function ImportPage() {
  const canContacts = useCan("contact:manage");
  const canItems = useCan("item:manage");
  const [entity, setEntity] = useState<Entity>("contacts");
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
  const columns = useMemo(() => (rows[0] ? Object.keys(rows[0]) : []), [rows]);
  const canImport = entity === "contacts" ? canContacts : canItems;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setResult(null);
    };
    reader.readAsText(file);
  }

  function switchEntity(next: Entity) {
    setEntity(next);
    setResult(null);
  }

  async function runImport() {
    if (rows.length === 0) {
      toast.error("Nothing to import — paste or upload a CSV first.");
      return;
    }
    setBusy(true);
    try {
      const fn = entity === "contacts" ? importContactsFn : importItemsFn;
      const res = await fn({ data: { rows } });
      setResult(res);
      toast.success(
        `Imported ${res.created} ${entity}` +
          (res.skipped ? `, skipped ${res.skipped} duplicate${res.skipped > 1 ? "s" : ""}` : "") +
          (res.errors.length
            ? `, ${res.errors.length} error${res.errors.length > 1 ? "s" : ""}`
            : ""),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Import Data" subtitle="Bulk-load contacts and items from a CSV file" />
      <div className="space-y-4 p-6">
        <div className="flex gap-2">
          {(["contacts", "items"] as Entity[]).map((e) => (
            <Button
              key={e}
              variant={entity === e ? "default" : "outline"}
              size="sm"
              className="capitalize"
              onClick={() => switchEntity(e)}
            >
              {e}
            </Button>
          ))}
        </div>

        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">
                Paste CSV, or upload a file — first row is the header.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Columns: <code className="rounded bg-muted px-1">{TEMPLATE[entity].headers}</code>.{" "}
                {TEMPLATE[entity].note} Only <span className="font-medium">name</span> is required;
                unknown columns are ignored.
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
              <FileUp className="h-4 w-4" />
              Upload .csv
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
            </label>
          </div>
          <Textarea
            className="min-h-40 font-mono text-xs"
            placeholder={`${TEMPLATE[entity].headers}\n…`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
          />
          <div className="mt-3 flex items-center gap-3">
            <Button
              disabled={busy || rows.length === 0 || !canImport}
              onClick={runImport}
              className="bg-gradient-brand text-white"
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Import {rows.length > 0 ? `${rows.length} row${rows.length > 1 ? "s" : ""}` : ""}
            </Button>
            {!canImport ? (
              <span className="text-xs text-muted-foreground">
                Your role can’t manage {entity}.
              </span>
            ) : null}
          </div>
        </Card>

        {rows.length > 0 && !result ? (
          <Card className="p-0">
            <div className="border-b p-3 text-sm font-medium">
              Preview — {rows.length} row{rows.length > 1 ? "s" : ""}
              {rows.length > 20 ? " (showing first 20)" : ""}
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 20).map((r, i) => (
                    <TableRow key={i}>
                      {columns.map((c) => (
                        <TableCell key={c} className="whitespace-nowrap text-xs">
                          {r[c]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        ) : null}

        {result ? (
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-success/10 text-success border-success/20">
                {result.created} created
              </Badge>
              <Badge variant="outline">{result.skipped} skipped (duplicates)</Badge>
              {result.errors.length ? (
                <Badge
                  variant="outline"
                  className="border-destructive/20 bg-destructive/10 text-destructive"
                >
                  {result.errors.length} error{result.errors.length > 1 ? "s" : ""}
                </Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">of {result.total} rows</span>
            </div>
            {result.errors.length ? (
              <div className="mt-3 max-h-60 overflow-auto rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Row</TableHead>
                      <TableHead>Problem</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.errors.map((err, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs tabular-nums">{err.row}</TableCell>
                        <TableCell className="text-xs">{err.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
