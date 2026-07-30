import { describe, expect, it } from "bun:test";
import { determineGstTreatment, splitGst, stateCodeOf } from "./gst";

describe("stateCodeOf", () => {
  it("takes the first two digits of a GSTIN", () => {
    expect(stateCodeOf("27AABCI1234N1Z5")).toBe("27");
    expect(stateCodeOf("06AAACZ4587R1Z5")).toBe("06");
  });
  it("returns null for missing or non-numeric prefixes", () => {
    expect(stateCodeOf(null)).toBeNull();
    expect(stateCodeOf("")).toBeNull();
    expect(stateCodeOf("XY123")).toBeNull();
  });
});

describe("determineGstTreatment", () => {
  it("same state → intra", () => {
    expect(determineGstTreatment("27", "27")).toBe("intra");
  });
  it("different state → inter", () => {
    expect(determineGstTreatment("27", "29")).toBe("inter");
  });
  it("unknown place of supply → intra (same-state assumption)", () => {
    expect(determineGstTreatment("27", null)).toBe("intra");
  });
  it("supplier not registered → unregistered", () => {
    expect(determineGstTreatment(null, "27")).toBe("unregistered");
  });
});

describe("splitGst", () => {
  it("intra splits into equal CGST + SGST", () => {
    expect(splitGst(1800n, "intra")).toEqual({ cgst: 900n, sgst: 900n, igst: 0n, unsplit: 0n });
  });
  it("intra puts the odd paisa on SGST so halves sum exactly", () => {
    const s = splitGst(1801n, "intra");
    expect(s.cgst).toBe(900n);
    expect(s.sgst).toBe(901n);
    expect(s.cgst + s.sgst).toBe(1801n);
  });
  it("inter is all IGST", () => {
    expect(splitGst(1800n, "inter")).toEqual({ cgst: 0n, sgst: 0n, igst: 1800n, unsplit: 0n });
  });
  it("unregistered stays unsplit", () => {
    expect(splitGst(1800n, "unregistered")).toEqual({
      cgst: 0n,
      sgst: 0n,
      igst: 0n,
      unsplit: 1800n,
    });
  });
});
