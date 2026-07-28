import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search, Loader2, FileText, Package, Users, type LucideIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { globalSearch } from "@/api";

type Hit = { id: string; label: string; sub: string; status?: string };
type Results = { invoices: Hit[]; items: Hit[]; contacts: Hit[] };

const EMPTY: Results = { invoices: [], items: [], contacts: [] };

type Row = { key: string; icon: LucideIcon; label: string; sub: string; onSelect: () => void };

/**
 * The header ⌘K search. Debounces keystrokes, calls the tenant-scoped
 * `globalSearch` server function, and shows a grouped dropdown of invoices,
 * items and contacts. Clicking a row (or pressing Enter on the first) routes to
 * the relevant screen. Read-only — it never mutates anything.
 */
export function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl-K focuses the box from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dismiss when clicking outside the search cluster.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Debounced fetch. Below two characters we don't query at all.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(EMPTY);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await globalSearch({ data: { q: term } });
        if (!cancelled) setResults(r);
      } catch {
        if (!cancelled) setResults(EMPTY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  function goto(row: () => void) {
    setOpen(false);
    setQ("");
    setResults(EMPTY);
    row();
  }

  // A single flat, ordered list so "Enter" can fire the first result and each
  // group can still render under its own heading.
  const rows = useMemo<Row[]>(() => {
    const invoiceRows: Row[] = results.invoices.map((r) => ({
      key: `inv-${r.id}`,
      icon: FileText,
      label: r.label,
      sub: r.sub,
      onSelect: () => navigate({ to: "/sales/invoices/$id", params: { id: r.id } }),
    }));
    const itemRows: Row[] = results.items.map((r) => ({
      key: `item-${r.id}`,
      icon: Package,
      label: r.label,
      sub: r.sub,
      onSelect: () => navigate({ to: "/inventory" }),
    }));
    const contactRows: Row[] = results.contacts.map((r) => ({
      key: `contact-${r.id}`,
      icon: Users,
      label: r.label,
      sub: r.sub,
      onSelect: () =>
        navigate({ to: r.sub === "vendor" ? "/purchases/vendors" : "/sales/customers" }),
    }));
    return [...invoiceRows, ...itemRows, ...contactRows];
  }, [results, navigate]);

  const total = rows.length;
  const showPanel = open && q.trim().length >= 2;

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md ml-2">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          } else if (e.key === "Enter" && rows.length > 0) {
            e.preventDefault();
            goto(rows[0].onSelect);
          }
        }}
        placeholder="Search invoices, items, customers…"
        className="pl-9 h-9 bg-muted/40 border-0"
        aria-label="Search invoices, items and customers"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 hidden md:inline-flex h-5 items-center gap-0.5 rounded border bg-background px-1.5 text-[10px] text-muted-foreground">
        ⌘K
      </kbd>

      {showPanel ? (
        <div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-lg border bg-popover shadow-elegant">
          {loading && total === 0 ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : total === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              No matches for “{q.trim()}”.
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-auto py-1">
              <ResultGroup
                title="Invoices"
                hits={results.invoices}
                icon={FileText}
                onSelect={(id) =>
                  goto(() => navigate({ to: "/sales/invoices/$id", params: { id } }))
                }
              />
              <ResultGroup
                title="Items"
                hits={results.items}
                icon={Package}
                onSelect={() => goto(() => navigate({ to: "/inventory" }))}
              />
              <ResultGroup
                title="Customers & Vendors"
                hits={results.contacts}
                icon={Users}
                onSelect={(_, sub) =>
                  goto(() =>
                    navigate({ to: sub === "vendor" ? "/purchases/vendors" : "/sales/customers" }),
                  )
                }
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ResultGroup({
  title,
  hits,
  icon: Icon,
  onSelect,
}: {
  title: string;
  hits: Hit[];
  icon: LucideIcon;
  onSelect: (id: string, sub: string) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <div className="px-1">
      <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {hits.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={() => onSelect(h.id, h.sub)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{h.label}</span>
          {h.sub ? (
            <span className="shrink-0 truncate text-xs capitalize text-muted-foreground">
              {h.sub}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
