/**
 * Exact decimal arithmetic for quantities, tax bases and exchange rates.
 *
 * Money is already exact (bigint minor units). This closes the other half of
 * that design: user-entered decimals — quantities like "2.5" or "0.0001",
 * exchange rates like "83.4567" — must become scaled integers WITHOUT passing
 * through IEEE-754 `Number()`. `Number("999999999999.9999") * 10000` loses
 * precision above 2^53; string parsing does not. Same input → same posted amount,
 * every time, at any magnitude.
 *
 * Rounding policy is round-half-away-from-zero (a.k.a. round-half-up on
 * magnitude), matching Indian GST rules and the money rounding used elsewhere.
 */

/**
 * Multiply then divide bigints, rounding the result half away from zero.
 * The single place tax/discount/FX fractions are resolved to a whole minor unit.
 */
export function mulDivRound(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDivRound: division by zero");
  const negative = amount < 0n !== numerator < 0n;
  const absAmount = amount < 0n ? -amount : amount;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const scaled = absAmount * absNum;
  const quotient = scaled / absDen;
  const remainder = scaled % absDen;
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parse a decimal STRING into an integer scaled by 10^scale — exactly, no float.
 *
 *   parseDecimalToScaled("2.5", 4)     → 25000n
 *   parseDecimalToScaled("0.0001", 4)  → 1n
 *   parseDecimalToScaled("1.23455", 4) → 12346n   (half-up on the dropped digit)
 *   parseDecimalToScaled("-3", 2)      → -300n
 *
 * Throws on non-numeric input rather than silently yielding NaN → 0.
 */
export function parseDecimalToScaled(input: string, scale: number): bigint {
  const s = (input ?? "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Not a decimal number: "${input}"`);
  }
  const negative = s.startsWith("-");
  const abs = negative ? s.slice(1) : s;
  const [intPart, fracPart = ""] = abs.split(".");
  const kept = fracPart.slice(0, scale).padEnd(scale, "0");
  let value = BigInt(intPart + kept);
  // Round half up using the first dropped fraction digit.
  const dropped = fracPart.charCodeAt(scale) - 48; // NaN (→ negative) when absent
  if (dropped >= 5) value += 1n;
  return negative ? -value : value;
}

/** Quantities are carried at 4 decimal places throughout the stock engine. */
export const QTY_SCALE = 4;

/** Parse a quantity string ("2.5") to its 4dp scaled bigint (25000). */
export function parseQuantity(qty: string): bigint {
  return parseDecimalToScaled(qty, QTY_SCALE);
}

/** Exchange rates are carried at 6 decimal places. */
export const RATE_SCALE = 6;
const RATE_ONE = 10n ** BigInt(RATE_SCALE);

/** Parse an exchange-rate string ("83.4567") to its 6dp scaled bigint. */
export function parseRate(rate: string): bigint {
  return parseDecimalToScaled(rate, RATE_SCALE);
}

/**
 * Convert a base-currency minor amount by a decimal-string exchange rate,
 * exactly. `minor × rate`, resolved to a whole minor unit (round half up).
 */
export function applyRate(minor: bigint, rate: string): bigint {
  return mulDivRound(minor, parseRate(rate), RATE_ONE);
}
