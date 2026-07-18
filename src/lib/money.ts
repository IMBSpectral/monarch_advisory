/**
 * Money formatting for the UI.
 *
 * The server sends minor units as strings (JSON has no bigint). These helpers
 * format them for display. Deliberately no add/subtract/multiply here — arithmetic
 * on money belongs on the server, in bigint, where it's exact. If a component
 * needs a computed figure, add it to the server function's return value rather
 * than deriving it in the browser.
 */

/** Minor units → display string, e.g. "285000000" → "₹28,50,000.00" */
export function formatMinor(
  minor: string | bigint,
  opts: { currency?: string; compact?: boolean; showPaise?: boolean } = {},
): string {
  const { currency = "INR", compact = false, showPaise = true } = opts;
  const value = typeof minor === "bigint" ? minor : BigInt(minor || "0");

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const symbol = currencySymbol(currency);

  if (compact) {
    return `${negative ? "-" : ""}${symbol}${compactIndian(abs)}`;
  }

  const major = abs / 100n;
  const paise = (abs % 100n).toString().padStart(2, "0");
  const grouped = groupIndian(major.toString());

  return `${negative ? "-" : ""}${symbol}${grouped}${showPaise ? `.${paise}` : ""}`;
}

/** Signed +/- prefix, for deltas. */
export function formatMinorSigned(
  minor: string | bigint,
  opts?: Parameters<typeof formatMinor>[1],
): string {
  const value = typeof minor === "bigint" ? minor : BigInt(minor || "0");
  const formatted = formatMinor(value < 0n ? -value : value, opts);
  return `${value < 0n ? "−" : "+"}${formatted}`;
}

/**
 * Indian digit grouping: last three digits, then pairs.
 * 12345678 → "1,23,45,678" (not the Western "12,345,678").
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/** 4875000000 (paise) → "48.75Cr" */
function compactIndian(absMinor: bigint): string {
  const rupees = Number(absMinor / 100n);
  if (rupees >= 1_00_00_000) return `${(rupees / 1_00_00_000).toFixed(2)}Cr`;
  if (rupees >= 1_00_000) return `${(rupees / 1_00_000).toFixed(2)}L`;
  if (rupees >= 1_000) return `${(rupees / 1_000).toFixed(1)}K`;
  return rupees.toString();
}

function currencySymbol(currency: string): string {
  const symbols: Record<string, string> = {
    INR: "₹",
    USD: "$",
    EUR: "€",
    GBP: "£",
    AED: "AED ",
    SGD: "S$",
  };
  return symbols[currency] ?? `${currency} `;
}

/** Parse user input ("2,85,000.50") into minor units. */
export function parseToMinor(input: string): bigint {
  const cleaned = input.replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-") return 0n;

  const negative = cleaned.startsWith("-");
  const abs = negative ? cleaned.slice(1) : cleaned;
  const [major = "0", fraction = ""] = abs.split(".");
  const paise = fraction.padEnd(2, "0").slice(0, 2);

  const value = BigInt(major || "0") * 100n + BigInt(paise || "0");
  return negative ? -value : value;
}

/** Percent-of, for progress bars and share-of-total. Returns 0–100. */
export function percentOf(part: string | bigint, whole: string | bigint): number {
  const p = typeof part === "bigint" ? part : BigInt(part || "0");
  const w = typeof whole === "bigint" ? whole : BigInt(whole || "0");
  if (w === 0n) return 0;
  return Number((p * 10000n) / w) / 100;
}
