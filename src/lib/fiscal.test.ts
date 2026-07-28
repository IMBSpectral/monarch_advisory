import { describe, expect, it } from "bun:test";
import {
  financialYearEndISO,
  financialYearStart,
  financialYearStartISO,
  fiscalYearLabelISO,
  fiscalYearToDateISO,
} from "./fiscal";

describe("financialYearStartISO", () => {
  it("April start (India): a July date is in the FY that began 1 April same year", () => {
    expect(financialYearStartISO("2026-07-28", 4)).toBe("2026-04-01");
  });
  it("April start: a February date belongs to the FY that began the previous April", () => {
    expect(financialYearStartISO("2026-02-15", 4)).toBe("2025-04-01");
  });
  it("April start: 1 April is the first day of the new FY", () => {
    expect(financialYearStartISO("2026-04-01", 4)).toBe("2026-04-01");
  });
  it("April start: 31 March is the last day of the prior FY", () => {
    expect(financialYearStartISO("2026-03-31", 4)).toBe("2025-04-01");
  });
  it("January start (calendar year)", () => {
    expect(financialYearStartISO("2026-07-28", 1)).toBe("2026-01-01");
  });
  it("July start: a March date belongs to the FY that began the previous July", () => {
    expect(financialYearStartISO("2026-03-10", 7)).toBe("2025-07-01");
  });
  it("July start: a July date starts the new FY", () => {
    expect(financialYearStartISO("2026-07-01", 7)).toBe("2026-07-01");
  });
});

describe("financialYearEndISO", () => {
  it("April start ends 31 March next year", () => {
    expect(financialYearEndISO("2026-07-28", 4)).toBe("2027-03-31");
  });
  it("January start ends 31 December same year", () => {
    expect(financialYearEndISO("2026-07-28", 1)).toBe("2026-12-31");
  });
  it("July start ends 30 June next year", () => {
    expect(financialYearEndISO("2026-03-10", 7)).toBe("2026-06-30");
  });
});

describe("fiscalYearLabelISO", () => {
  it("April start spans two calendar years", () => {
    expect(fiscalYearLabelISO("2026-07-28", 4)).toBe("FY 2026-27");
    expect(fiscalYearLabelISO("2026-02-15", 4)).toBe("FY 2025-26");
  });
  it("January start is a single year", () => {
    expect(fiscalYearLabelISO("2026-07-28", 1)).toBe("FY 2026");
  });
});

describe("fiscalYearToDateISO", () => {
  it("runs from the FY start to the as-of date", () => {
    expect(fiscalYearToDateISO("2026-07-28", 4)).toEqual({ from: "2026-04-01", to: "2026-07-28" });
  });
});

describe("financialYearStart (Date-based, client presets)", () => {
  it("April start: July 2026 → 1 Apr 2026", () => {
    const s = financialYearStart(new Date(2026, 6, 28), 4); // month 6 = July
    expect([s.getFullYear(), s.getMonth(), s.getDate()]).toEqual([2026, 3, 1]);
  });
  it("April start: Feb 2026 → 1 Apr 2025", () => {
    const s = financialYearStart(new Date(2026, 1, 15), 4);
    expect([s.getFullYear(), s.getMonth(), s.getDate()]).toEqual([2025, 3, 1]);
  });
  it("defaults to April when no start month is given", () => {
    const s = financialYearStart(new Date(2026, 6, 28));
    expect(s.getMonth()).toBe(3);
  });
});
