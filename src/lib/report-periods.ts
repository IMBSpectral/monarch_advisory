/**
 * Reporting-period presets for the P&L and Balance Sheet date pickers.
 *
 * A period is two `yyyy-MM-dd` strings, `from` and `to`. The strings are compared
 * against the `entry_date` DATE column server-side, so there is no time-of-day or
 * timezone ambiguity at the day boundary — a plain calendar date in, a plain
 * calendar date out.
 *
 * The financial year starts 1 April (Indian FY), matching `defaultPeriod()` in
 * src/api/index.ts. "This …" presets run to today (period-to-date); "Last …"
 * presets cover the whole completed period.
 *
 * The active preset KEY is carried in the URL alongside the dates, so nothing
 * here is evaluated during render — `resolvePreset` only runs inside a user
 * event. That keeps the server-rendered picker and the client hydrate identical
 * even across a midnight tick.
 */

import {
  addDays,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  format,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  subMonths,
  subQuarters,
  subWeeks,
} from "date-fns";
import { financialYearStart } from "./fiscal";

export type PresetKey =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_financial_year"
  | "last_financial_year"
  | "custom";

export type FixedPreset = Exclude<PresetKey, "custom">;

export type DateRange = { from: string; to: string };

/** Ordered for the picker menu. */
export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This Week" },
  { key: "last_week", label: "Last Week" },
  { key: "this_month", label: "This Month" },
  { key: "last_month", label: "Last Month" },
  { key: "this_quarter", label: "This Quarter" },
  { key: "last_quarter", label: "Last Quarter" },
  { key: "this_financial_year", label: "This Financial Year" },
  { key: "last_financial_year", label: "Last Financial Year" },
  { key: "custom", label: "Custom Range" },
];

/** The picker defaults to the same window the API defaults to (current FY-to-date). */
export const DEFAULT_PRESET: FixedPreset = "this_financial_year";

export function presetLabel(key: PresetKey): string {
  return PRESETS.find((p) => p.key === key)?.label ?? "Custom Range";
}

/** Monday-start weeks, the norm for business reporting. */
const WEEK = { weekStartsOn: 1 as const };
const fmt = (d: Date) => format(d, "yyyy-MM-dd");

/**
 * Resolve a fixed preset to a concrete date range. Call only from event
 * handlers (it reads the clock) — never during render. `startMonth` is the org's
 * fiscal-year start month (1-12); it drives the two financial-year presets.
 */
export function resolvePreset(
  key: FixedPreset,
  today: Date = new Date(),
  startMonth = 4,
): DateRange {
  switch (key) {
    case "today":
      return { from: fmt(today), to: fmt(today) };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: fmt(y), to: fmt(y) };
    }
    case "this_week":
      return { from: fmt(startOfWeek(today, WEEK)), to: fmt(today) };
    case "last_week": {
      const w = subWeeks(today, 1);
      return { from: fmt(startOfWeek(w, WEEK)), to: fmt(endOfWeek(w, WEEK)) };
    }
    case "this_month":
      return { from: fmt(startOfMonth(today)), to: fmt(today) };
    case "last_month": {
      const m = subMonths(today, 1);
      return { from: fmt(startOfMonth(m)), to: fmt(endOfMonth(m)) };
    }
    case "this_quarter":
      return { from: fmt(startOfQuarter(today)), to: fmt(today) };
    case "last_quarter": {
      const q = subQuarters(today, 1);
      return { from: fmt(startOfQuarter(q)), to: fmt(endOfQuarter(q)) };
    }
    case "this_financial_year":
      return { from: fmt(financialYearStart(today, startMonth)), to: fmt(today) };
    case "last_financial_year": {
      const thisStart = financialYearStart(today, startMonth);
      const prevStart = new Date(thisStart.getFullYear() - 1, thisStart.getMonth(), 1);
      return { from: fmt(prevStart), to: fmt(addDays(thisStart, -1)) };
    }
  }
}

/** Order a possibly-inverted custom range so `from <= to`. */
export function normalizeRange(from: string, to: string): DateRange {
  return from <= to ? { from, to } : { from: to, to: from };
}
