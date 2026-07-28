import { Plus, Trash2 } from "lucide-react";
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

export const NO_ITEM = "__none__";
export const NO_TAX = "__none__";

export type Item = {
  id: string;
  name: string;
  sku?: string | null;
  salePrice?: string | null;
  purchasePrice?: string | null;
};
export type TaxRate = { id: string; name: string; ratePercent: number };

export type LineDraft = {
  itemId: string;
  description: string;
  quantity: string;
  unitPriceRupees: string;
  taxRateId: string;
};

export const emptyLine = (): LineDraft => ({
  itemId: NO_ITEM,
  description: "",
  quantity: "1",
  unitPriceRupees: "",
  taxRateId: NO_TAX,
});

/**
 * The shared line grid used by every voucher dialog. Picking a stock item
 * auto-fills the description and a sensible unit price (sale or cost, per
 * `priceField`). Everything else stays free-text so services/one-offs still work.
 */
export function LinesEditor({
  lines,
  setLines,
  items,
  taxRates,
  priceField = "salePrice",
  showTax = true,
  requireItem = false,
}: {
  lines: LineDraft[];
  setLines: (updater: (prev: LineDraft[]) => LineDraft[]) => void;
  items: Item[];
  taxRates: TaxRate[];
  priceField?: "salePrice" | "purchasePrice";
  showTax?: boolean;
  requireItem?: boolean;
}) {
  const update = (i: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const onPickItem = (i: number, itemId: string) => {
    const item = items.find((x) => x.id === itemId);
    if (!item) {
      update(i, { itemId });
      return;
    }
    const priceMinor = item[priceField];
    update(i, {
      itemId,
      description: item.name,
      unitPriceRupees: priceMinor ? String(Number(priceMinor) / 100) : "",
    });
  };

  const cols = showTax
    ? "grid-cols-[1.3fr_1.6fr_4rem_6rem_7rem_2rem]"
    : "grid-cols-[1.3fr_1.6fr_4rem_6rem_2rem]";

  return (
    <div className="space-y-2">
      <Label>Lines</Label>
      {lines.map((line, i) => (
        <div key={i} className={`grid ${cols} items-center gap-2`}>
          <Select value={line.itemId} onValueChange={(v) => onPickItem(i, v)}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Item" />
            </SelectTrigger>
            <SelectContent>
              {!requireItem ? <SelectItem value={NO_ITEM}>— none —</SelectItem> : null}
              {items.map((it) => (
                <SelectItem key={it.id} value={it.id}>
                  {it.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Description"
            value={line.description}
            onChange={(e) => update(i, { description: e.target.value })}
          />
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="Qty"
            value={line.quantity}
            onChange={(e) => update(i, { quantity: e.target.value })}
          />
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="Unit ₹"
            value={line.unitPriceRupees}
            onChange={(e) => update(i, { unitPriceRupees: e.target.value })}
          />
          {showTax ? (
            <Select value={line.taxRateId} onValueChange={(v) => update(i, { taxRateId: v })}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TAX}>No tax</SelectItem>
                {taxRates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-8"
            disabled={lines.length === 1}
            onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setLines((prev) => [...prev, emptyLine()])}
      >
        <Plus className="mr-1.5 h-4 w-4" />
        Add line
      </Button>
    </div>
  );
}

export const noteStatusStyle: Record<string, string> = {
  posted: "bg-success/10 text-success border-success/20",
  draft: "bg-muted text-muted-foreground border-border",
  void: "bg-muted text-muted-foreground border-border",
  confirmed: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  invoiced: "bg-success/10 text-success border-success/20",
  partially_invoiced: "bg-warning/10 text-warning-foreground border-warning/30",
  cancelled: "bg-muted text-muted-foreground border-border",
};

export const noteStatusLabel: Record<string, string> = {
  posted: "Posted",
  draft: "Draft",
  void: "Void",
  confirmed: "Confirmed",
  invoiced: "Invoiced",
  partially_invoiced: "Partial",
  cancelled: "Cancelled",
};

/** Serialise a line draft into the API's shape (rupees → paise string). */
export function toApiLines(lines: LineDraft[]) {
  return lines
    .filter((l) => l.description.trim() && Number(l.unitPriceRupees) > 0)
    .map((l) => ({
      itemId: l.itemId === NO_ITEM ? null : l.itemId,
      description: l.description.trim(),
      quantity: l.quantity || "1",
      unitPriceMinor: String(Math.round(Number(l.unitPriceRupees) * 100)),
      taxRateId: l.taxRateId === NO_TAX ? null : l.taxRateId,
    }));
}
