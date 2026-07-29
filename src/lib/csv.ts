/**
 * A small, correct CSV reader for the data-import screens.
 *
 * Handles the things a naive `split(",")` gets wrong: quoted fields containing
 * commas or newlines, and escaped quotes (`""`). The first non-empty line is the
 * header; each subsequent row becomes an object keyed by the lower-cased,
 * trimmed header names, so the importer can look columns up by name regardless of
 * the spreadsheet's exact casing or order.
 */

/** Split raw CSV text into rows of raw string cells (RFC-4180-ish). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else if (c === "\r") {
      // ignore — handled by the \n branch
    } else {
      field += c;
      sawAny = true;
    }
  }
  if (sawAny || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV text into records keyed by header. Header names are lower-cased and
 * trimmed; empty rows are dropped. Returns `[]` when there's no data row.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 1) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) rec[h] = (r[i] ?? "").trim();
    });
    return rec;
  });
}
