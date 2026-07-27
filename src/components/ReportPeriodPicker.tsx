import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { format, parseISO } from "date-fns";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  PRESETS,
  presetLabel,
  resolvePreset,
  normalizeRange,
  type FixedPreset,
  type PresetKey,
} from "@/lib/report-periods";

const pretty = (d: string) => format(parseISO(d), "dd MMM yyyy");

type RangeProps = {
  mode: "range";
  preset: PresetKey;
  from: string;
  to: string;
  onApply: (v: { preset: PresetKey; from: string; to: string }) => void;
};

type AsOfProps = {
  mode: "asOf";
  preset: PresetKey;
  asOf: string;
  onApply: (v: { preset: PresetKey; asOf: string }) => void;
};

/**
 * Reporting-period selector used by the P&L and Balance Sheet. Quick-filter
 * presets on the left; explicit Start/End (or a single "as of") date on the
 * right. In "range" mode it picks a from/to window (P&L); in "asOf" mode a single
 * end date (Balance Sheet — balances as of that day). The parent owns the value
 * (URL search params) and re-fetches on `onApply`, so the report, its header, and
 * any export all move together.
 */
export function ReportPeriodPicker(props: RangeProps | AsOfProps) {
  const [open, setOpen] = useState(false);

  const applyPreset = (key: FixedPreset) => {
    const r = resolvePreset(key);
    if (props.mode === "range") props.onApply({ preset: key, from: r.from, to: r.to });
    else props.onApply({ preset: key, asOf: r.to });
    setOpen(false);
  };

  const label =
    props.mode === "asOf"
      ? `As of ${pretty(props.asOf)}`
      : `${pretty(props.from)} – ${pretty(props.to)}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <CalendarDays className="h-4 w-4" />
          <span className="hidden text-muted-foreground sm:inline">
            {presetLabel(props.preset)}:
          </span>
          <span className="font-medium">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-row flex-wrap gap-1 border-b p-2 sm:w-44 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r">
            {PRESETS.filter((p) => p.key !== "custom").map((p) => (
              <Button
                key={p.key}
                variant={props.preset === p.key ? "secondary" : "ghost"}
                size="sm"
                className="justify-start text-xs"
                onClick={() => applyPreset(p.key as FixedPreset)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {props.mode === "range" ? (
            <CustomRange
              from={props.from}
              to={props.to}
              onApply={(from, to) => {
                props.onApply({ preset: "custom", from, to });
                setOpen(false);
              }}
            />
          ) : (
            <CustomAsOf
              asOf={props.asOf}
              onApply={(asOf) => {
                props.onApply({ preset: "custom", asOf });
                setOpen(false);
              }}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Start + End date inputs for a P&L custom range, with a Start ≤ End guard. */
function CustomRange({
  from,
  to,
  onApply,
}: {
  from: string;
  to: string;
  onApply: (from: string, to: string) => void;
}) {
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const inverted = start > end;

  return (
    <div className="w-60 space-y-3 p-3">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Custom range
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="rp-start" className="text-xs">
          Start date
        </Label>
        <Input
          id="rp-start"
          type="date"
          value={start}
          max={end || undefined}
          onChange={(e) => setStart(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rp-end" className="text-xs">
          End date
        </Label>
        <Input
          id="rp-end"
          type="date"
          value={end}
          min={start || undefined}
          onChange={(e) => setEnd(e.target.value)}
        />
      </div>
      {inverted && (
        <p className="text-xs text-destructive">Start date must be on or before the end date.</p>
      )}
      <Button
        size="sm"
        className="w-full"
        disabled={!start || !end || inverted}
        onClick={() => {
          const n = normalizeRange(start, end);
          onApply(n.from, n.to);
        }}
      >
        Apply
      </Button>
    </div>
  );
}

/** Single "as of" date input for the Balance Sheet. */
function CustomAsOf({ asOf, onApply }: { asOf: string; onApply: (asOf: string) => void }) {
  const [date, setDate] = useState(asOf);

  return (
    <div className="w-60 space-y-3 p-3">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Custom date
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="rp-asof" className="text-xs">
          As of date
        </Label>
        <Input id="rp-asof" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <Button size="sm" className="w-full" disabled={!date} onClick={() => onApply(date)}>
        Apply
      </Button>
    </div>
  );
}
