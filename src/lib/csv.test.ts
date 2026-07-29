import { describe, expect, it } from "bun:test";
import { parseCsv, parseCsvRows } from "./csv";

describe("parseCsvRows", () => {
  it("splits simple rows", () => {
    expect(parseCsvRows("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });
  it("keeps commas inside quoted fields", () => {
    expect(parseCsvRows('name,addr\n"Acme, Inc.","12, MG Road"')).toEqual([
      ["name", "addr"],
      ["Acme, Inc.", "12, MG Road"],
    ]);
  });
  it("unescapes doubled quotes", () => {
    expect(parseCsvRows('q\n"She said ""hi"""')).toEqual([["q"], ['She said "hi"']]);
  });
  it("handles a newline inside a quoted field", () => {
    expect(parseCsvRows('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });
  it("tolerates a trailing newline", () => {
    expect(parseCsvRows("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCsv", () => {
  it("keys rows by lower-cased header", () => {
    const rows = parseCsv("Name,Email\nAcme,acme@x.com\nBeta,beta@x.com");
    expect(rows).toEqual([
      { name: "Acme", email: "acme@x.com" },
      { name: "Beta", email: "beta@x.com" },
    ]);
  });
  it("drops blank lines and trims", () => {
    const rows = parseCsv("name\n  Acme  \n\n");
    expect(rows).toEqual([{ name: "Acme" }]);
  });
  it("returns [] with no data rows", () => {
    expect(parseCsv("name,email")).toEqual([]);
    expect(parseCsv("")).toEqual([]);
  });
  it("fills missing trailing cells with empty strings", () => {
    expect(parseCsv("a,b,c\n1,2")).toEqual([{ a: "1", b: "2", c: "" }]);
  });
});
