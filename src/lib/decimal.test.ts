import { test, expect, describe } from "bun:test";
import { parseDecimalToScaled, parseQuantity, parseRate, applyRate, mulDivRound } from "./decimal";

describe("parseDecimalToScaled", () => {
  test("common quantities scale to 4dp exactly", () => {
    expect(parseDecimalToScaled("2.5", 4)).toBe(25000n);
    expect(parseDecimalToScaled("1", 4)).toBe(10000n);
    expect(parseDecimalToScaled("0.0001", 4)).toBe(1n);
    expect(parseDecimalToScaled("0", 4)).toBe(0n);
    expect(parseDecimalToScaled("2.50000", 4)).toBe(25000n); // trailing zeros
  });

  test("rounds half away from zero on the dropped digit", () => {
    expect(parseDecimalToScaled("1.23455", 4)).toBe(12346n); // 5 → up
    expect(parseDecimalToScaled("1.23454", 4)).toBe(12345n); // 4 → down
    expect(parseDecimalToScaled("1.99999", 4)).toBe(20000n); // carries
  });

  test("negatives (reversals) keep sign and magnitude", () => {
    expect(parseDecimalToScaled("-3", 2)).toBe(-300n);
    expect(parseDecimalToScaled("-1.005", 2)).toBe(-101n); // half-up on magnitude
  });

  test("very large values stay exact where IEEE-754 would not", () => {
    // Number("999999999999.9999") * 10000 loses precision (> 2^53); string parse doesn't.
    expect(parseDecimalToScaled("999999999999.9999", 4)).toBe(9999999999999999n);
    const floaty = BigInt(Math.round(Number("999999999999.9999") * 10_000));
    expect(floaty).not.toBe(9999999999999999n); // proves the old method was wrong
  });

  test("rejects non-numeric input instead of yielding 0", () => {
    expect(() => parseDecimalToScaled("abc", 4)).toThrow();
    expect(() => parseDecimalToScaled("", 4)).toThrow();
    expect(() => parseDecimalToScaled("1.2.3", 4)).toThrow();
  });
});

describe("mulDivRound", () => {
  test("GST 18% on ₹1,234.56 rounds the final paisa half-up", () => {
    // 123456 paise × 1800 / 10000 = 22222.08 → 22222
    expect(mulDivRound(123456n, 1800n, 10000n)).toBe(22222n);
  });
  test("exact half rounds up (away from zero)", () => {
    expect(mulDivRound(5n, 1n, 2n)).toBe(3n); // 2.5 → 3
    expect(mulDivRound(-5n, 1n, 2n)).toBe(-3n); // -2.5 → -3
  });
  test("throws on divide by zero", () => {
    expect(() => mulDivRound(1n, 1n, 0n)).toThrow();
  });
});

describe("applyRate (FX)", () => {
  test("applies a many-decimal rate to minor units exactly", () => {
    // $100.00 = 10000 minor; rate 83.4567 → 834567 paise
    expect(applyRate(10000n, "83.4567")).toBe(834567n);
  });
  test("rate 1 is a no-op", () => {
    expect(applyRate(123456n, "1")).toBe(123456n);
  });
  test("rounds half-up to the paisa", () => {
    // 3 minor × 1.5 = 4.5 → 5
    expect(applyRate(3n, "1.5")).toBe(5n);
  });
});

describe("helpers", () => {
  test("parseQuantity uses 4dp, parseRate uses 6dp", () => {
    expect(parseQuantity("2.5")).toBe(25000n);
    expect(parseRate("83.5")).toBe(83500000n);
  });
});
