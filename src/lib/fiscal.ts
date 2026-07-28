/**
 * The fiscal-year model. One source of truth for "which financial year does this
 * date fall in, and where does it start and end", driven by the org's configured
 * `fiscalYearStartMonth` (1 = January … 4 = April for India … 12 = December).
 *
 * Two flavours, deliberately:
 *   • Date-based helpers for the CLIENT date pickers, which work in local time
 *     with `date-fns` (matching how the presets have always behaved).
 *   • ISO-string helpers for the SERVER, which compares plain `yyyy-MM-dd` values
 *     against the `entry_date` DATE column — no Date object, so no timezone can
 *     shift a fiscal-year boundary by a day.
 *
 * `startMonth` defaults to 4 (April) everywhere, so any caller that hasn't been
 * taught about the setting keeps the previous India-default behaviour.
 */

/** The financial-year-start date (1st of `startMonth`) on or before `d`. */
export function financialYearStart(d: Date, startMonth = 4): Date {
  const m0 = startMonth - 1; // getMonth() is 0-indexed
  const y = d.getMonth() >= m0 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, m0, 1);
}

/** ISO `yyyy-MM-01` of the FY containing the ISO date `asOf` (e.g. "2026-07-28"). */
export function financialYearStartISO(asOf: string, startMonth = 4): string {
  const [y, m] = asOf.split("-").map(Number); // m is 1-indexed
  const fyYear = m >= startMonth ? y : y - 1;
  return `${fyYear}-${String(startMonth).padStart(2, "0")}-01`;
}

/** ISO date of the last day of the FY containing `asOf` (day before next FY start). */
export function financialYearEndISO(asOf: string, startMonth = 4): string {
  const startYear = Number(financialYearStartISO(asOf, startMonth).slice(0, 4));
  // Last day before the next FY start. Build the next start in UTC and step back
  // one day so month lengths (and Feb 29) are handled by the Date arithmetic.
  const nextStart = new Date(Date.UTC(startYear + 1, startMonth - 1, 1));
  nextStart.setUTCDate(nextStart.getUTCDate() - 1);
  return nextStart.toISOString().slice(0, 10);
}

/**
 * Fiscal-year label, e.g. "FY 2026-27" for an April start, or "FY 2026" when the
 * year starts in January (start and end fall in the same calendar year).
 */
export function fiscalYearLabelISO(asOf: string, startMonth = 4): string {
  const y = Number(financialYearStartISO(asOf, startMonth).slice(0, 4));
  if (startMonth === 1) return `FY ${y}`;
  return `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** Fiscal-year-to-date window: FY start through `asOf`, both ISO. */
export function fiscalYearToDateISO(asOf: string, startMonth = 4): { from: string; to: string } {
  return { from: financialYearStartISO(asOf, startMonth), to: asOf };
}
