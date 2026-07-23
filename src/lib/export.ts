/**
 * Client-side CSV export.
 *
 * The "Export" buttons across the app produce a CSV of whatever is currently on
 * screen. This is deliberately client-side: the data has already been fetched
 * and filtered, so re-requesting it from the server just to format it would be
 * wasteful and could drift from what the user is actually looking at.
 *
 * It is display-grade, not an accounting export. Figures are already formatted
 * strings (₹, Indian grouping); a statutory export would go through a server
 * function that emits raw minor units. This is for "email me this list", not for
 * filing.
 */

/** Wrap a cell so commas, quotes and newlines can't break the row structure. */
function escapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a CSV and trigger a download. No-op outside the browser (SSR), so it is
 * safe to call from an event handler without guarding.
 */
export function downloadCsv(filename: string, headers: string[], rows: string[][]): void {
  if (typeof document === "undefined") return;

  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(","));
  // Prepend a BOM so Excel opens UTF-8 (₹ and names) correctly.
  const csv = "﻿" + lines.join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
