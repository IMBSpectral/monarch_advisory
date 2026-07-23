# Phase 1 — Inventory / Stock Ledger — Implementation Spec

> Companion to `tally-parity-roadmap.md`. This is the drop-in design for Monarch's
> perpetual inventory engine: a **stock ledger that mirrors the general ledger**,
> valuation (weighted-average + FIFO), and automatic COGS/stock-in postings that
> reuse the existing `postJournalEntry` chokepoint.

> **STATUS (2026-07-22): Milestone 1a SHIPPED.** Schema, migration
> (`drizzle/0004_remarkable_shard.sql`), engine (`src/server/inventory.ts`),
> hooks in `postBill`/`postInvoice`/`voidInvoice`/`voidBill`/POS, seed opening
> stock, and tests are all in. `db:test` = 45 passing (incl. the WA case, negative
> stock, void restock); `db:verify` asserts `Σ stock value == Inventory account`.
> Verified live in the app (Balance Sheet inventory asset, P&L COGS/gross profit,
> a POS sale relieving stock). **Deferred:** FIFO (1b), per-line warehouse,
> adjustment/transfer vouchers, and surfacing on-hand in the Inventory list UI (1d).

## 0. Design invariants

1. **The stock ledger mirrors the journal.** `stock_movements` is to inventory
   what `journal_lines` is to money: append-only, signed, and every report is a
   `SUM`. Positive quantity/value = **in**, negative = **out**. On-hand =
   `Σ quantity`; stock value = `Σ value_minor`.
2. **Money still flows through `postJournalEntry` only.** Stock movements are
   posted inside the *same DB transaction* as the JE they accompany, never on
   their own money path.
3. **The reconciliation identity that must always hold:**
   `Σ value_minor over all inventory items  ==  balance of the Inventory control
   account (subtype 'inventory')`. Enforced in `db:verify`.
4. **Cost is integer paise (bigint), quantity is `numeric(18,4)`** — matching the
   existing `invoice_lines.quantity`. Proportional (weighted-average) issue costs
   are rounded to the paise and the residue is carried, so the identity in (3)
   holds exactly.
5. **RLS, immutability, soft-delete, audit** — every new table follows the same
   conventions as the core schema (migration 0002 pattern).

## 0.1 Milestones (ship in this order)

| # | Milestone | Contents |
|---|---|---|
| 1a | **Weighted-average core** | schema + migration, `postStockMovement`, WA valuation, purchase stock-in, sale COGS, void restock, `db:verify` identity |
| 1b | **FIFO** | `stock_layers`, FIFO consume, per-item `valuation_method` |
| 1c | **Manual vouchers** | opening stock, stock adjustment, stock transfer |
| 1d | **Reports + UI** | stock summary / valuation / movement reports, Inventory screen columns, warehouse & adjustment/transfer UI |

---

## 1. Data model

### 1.1 New enums (`src/db/schema.ts`, in the Enums block)

```ts
export const valuationMethodEnum = pgEnum("valuation_method", [
  "weighted_average", // default
  "fifo",
]);

export const stockMoveSourceEnum = pgEnum("stock_move_source", [
  "purchase",          // bill post — goods in
  "sale",              // invoice / POS post — goods out
  "sales_return",      // credit note (Phase 2)
  "purchase_return",   // debit note  (Phase 2)
  "adjustment",        // manual write-up / write-down
  "transfer_out",      // warehouse -> warehouse
  "transfer_in",
  "opening_balance",   // opening stock load
  "reversal",          // restock from a void/reverse
]);
```

`journal_source` already contains `inventory_adjustment` and
`opening_balance`, and `account_subtype` already contains `inventory` and
`cost_of_goods_sold` — no enum change needed there.

### 1.2 Alter existing tables

```ts
// items: add valuation config. isInventoryTracked / inventoryAccountId /
// purchaseAccountId already exist.
valuationMethod: valuationMethodEnum("valuation_method").notNull().default("weighted_average"),
cogsAccountId: uuid("cogs_account_id").references(() => accounts.id), // nullable → resolve by subtype
reorderLevel: numeric("reorder_level", { precision: 18, scale: 4 }),  // nullable

// invoice_lines AND bill_lines: which godown the goods leave/enter.
warehouseId: uuid("warehouse_id").references(() => warehouses.id), // nullable → org default
```

### 1.3 New tables

```ts
/* Godowns / stock locations. */
export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("warehouse_org_code_idx").on(t.orgId, t.code),
    // At most one default per org (partial unique via migration, see §2).
  ],
);

/*
 * THE STOCK LEDGER. Signed like journal_lines: qty/value > 0 = in, < 0 = out.
 * Immutable. `jeId` links the goods move to the money move it rode in on.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull().references(() => items.id),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id),
    moveDate: date("move_date").notNull(),
    /** Signed. + = received, - = issued. numeric to allow 2.5 kg etc. */
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    /** Signed base-currency paise moved into/out of stock value. */
    valueMinor: money("value_minor").notNull(),
    /** Absolute unit cost applied to this move, for audit/trace. */
    unitCostMinor: money("unit_cost_minor").notNull(),
    source: stockMoveSourceEnum("source").notNull(),
    /** The document that caused the move (invoice/bill/adjustment id). */
    sourceDocumentId: uuid("source_document_id"),
    /** The journal entry posted alongside (null for non-financial moves e.g. transfer). */
    jeId: uuid("je_id").references(() => journalEntries.id),
    memo: text("memo"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("smove_org_item_wh_idx").on(t.orgId, t.itemId, t.warehouseId),
    index("smove_org_date_idx").on(t.orgId, t.moveDate),
    index("smove_source_doc_idx").on(t.source, t.sourceDocumentId),
    // A zero-quantity move is always a bug.
    check("smove_nonzero_qty", sql`${t.quantity} <> 0`),
  ],
);

/*
 * Cached on-hand per (item, warehouse). Rebuildable from stock_movements;
 * exists for O(1) reads and to make the WA running cost cheap. Mirrors the
 * "cached but reconciled" pattern used for AR aging.
 */
export const itemStockLevels = pgTable(
  "item_stock_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull().references(() => items.id),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id),
    onHandQty: numeric("on_hand_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    valueMinor: money("value_minor").notNull().default(sql`0`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("stocklevel_item_wh_idx").on(t.itemId, t.warehouseId),
    index("stocklevel_org_idx").on(t.orgId),
    // Stock value can never be negative; on-hand can't be negative unless the org
    // opts into it (enforced in code, mirrored here for the default case).
    check("stocklevel_value_nonneg", sql`${t.valueMinor} >= 0`),
  ],
);

/* FIFO layers (Milestone 1b). One row per receipt, consumed oldest-first. */
export const stockLayers = pgTable(
  "stock_layers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull().references(() => items.id),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id),
    receivedAt: date("received_at").notNull(),
    originalQty: numeric("original_qty", { precision: 18, scale: 4 }).notNull(),
    remainingQty: numeric("remaining_qty", { precision: 18, scale: 4 }).notNull(),
    unitCostMinor: money("unit_cost_minor").notNull(),
    sourceMovementId: uuid("source_movement_id").references(() => stockMovements.id),
    ...timestamps,
  },
  (t) => [
    // Consume ordered by (receivedAt, id); index supports that scan.
    index("slayer_fifo_idx").on(t.orgId, t.itemId, t.warehouseId, t.receivedAt),
  ],
);
```

---

## 2. Migration `drizzle/0004_inventory.sql`

Generate the DDL with `bun run db:generate`, then **append** the RLS/grants/seed
block below (drizzle-kit writes the `CREATE TABLE`s; the security is hand-added,
exactly as 0002 did). RLS is not expressible in the Drizzle schema, so it lives in
the migration.

```sql
-- New org-scoped tables must be enrolled in RLS the same way as migration 0002.
DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'warehouses', 'stock_movements', 'item_stock_levels', 'stock_layers'
  ];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (org_id = current_setting(''app.org_id'', true)::uuid)
         WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- stock_movements is append-only, like the journal. Revoke mutation from the app.
REVOKE UPDATE, DELETE ON stock_movements FROM monarch_app;

-- At most one default warehouse per org.
CREATE UNIQUE INDEX warehouse_one_default_per_org
  ON warehouses (org_id) WHERE is_default;

-- Extend the document-sequence catalogue so stock vouchers get numbers.
-- (claimNextNumber reads these rows; see §3.4 for the type-union change.)
INSERT INTO document_sequences (org_id, document_type, prefix, next_number, pad_width)
SELECT id, 'stock_adjustment', 'ADJ-', 1, 5 FROM organizations
ON CONFLICT DO NOTHING;
INSERT INTO document_sequences (org_id, document_type, prefix, next_number, pad_width)
SELECT id, 'stock_transfer', 'TRF-', 1, 5 FROM organizations
ON CONFLICT DO NOTHING;

-- Every existing org gets a default warehouse so current invoices/bills resolve.
INSERT INTO warehouses (org_id, code, name, is_default)
SELECT id, 'MAIN', 'Main Warehouse', true FROM organizations
ON CONFLICT DO NOTHING;
```

> `document_sequences` currently has a unique index on `(org_id, document_type)` —
> confirm the `ON CONFLICT` target matches it, or name the constraint explicitly.

---

## 3. Server: `src/server/inventory.ts` (masters + ledger)

New module. Depends on `ledger.ts` and composes inside caller transactions the
same way `postJournalEntry` does (`existingTx` parameter).

### 3.1 Types

```ts
export type ValuationMethod = "weighted_average" | "fifo";

export type StockMoveInput = {
  orgId: string;
  itemId: string;
  warehouseId: string;
  moveDate: string;            // YYYY-MM-DD
  quantity: string;           // signed decimal string, + in / - out
  source: (typeof stockMovements.$inferInsert)["source"];
  sourceDocumentId?: string | null;
  jeId?: string | null;
  /** For inbound moves: the known unit cost. For outbound: ignored (valued from stock). */
  unitCostMinor?: bigint;
  userId?: string | null;
  memo?: string | null;
  allowNegative?: boolean;    // default false
};

export type StockMoveResult = {
  movementId: string;
  valueMinor: bigint;         // signed base-currency value moved
  unitCostMinor: bigint;      // absolute unit cost applied
};
```

### 3.2 The stock chokepoint

```ts
/**
 * Post one stock movement and update the cached level, atomically.
 * INBOUND  (quantity > 0): value = quantity * unitCostMinor (unitCost required).
 * OUTBOUND (quantity < 0): value computed by the item's valuation method from
 *   current stock; unitCostMinor is ignored.
 * Always call inside the same tx as the money entry it accompanies.
 */
export async function postStockMovement(
  input: StockMoveInput,
  tx: DbOrTx,
): Promise<StockMoveResult> {
  const qty = parseDecimal(input.quantity);              // -> {scaled: bigint, ...} at 4dp
  if (qty.isZero) throw new LedgerError("Zero-quantity stock move.", "STOCK_ZERO_QTY");

  const level = await lockLevel(tx, input.orgId, input.itemId, input.warehouseId); // SELECT … FOR UPDATE

  let valueMinor: bigint;
  let unitCostMinor: bigint;

  if (qty.isPositive) {
    // Receipt.
    unitCostMinor = input.unitCostMinor ?? 0n;
    valueMinor = mulQtyCost(qty, unitCostMinor);         // round to paise
    // WA: fold into running value/qty. FIFO: also open a layer (§3.3).
  } else {
    // Issue. Value it from stock; never trust a passed-in cost.
    const outQty = qty.abs;
    if (!input.allowNegative && outQty.gt(level.onHandQty)) {
      throw new LedgerError(
        `Insufficient stock for item ${input.itemId}: on hand ${level.onHandQty}, issuing ${outQty}.`,
        "NEGATIVE_STOCK",
      );
    }
    ({ valueMinor, unitCostMinor } = await computeIssueValue(tx, input, level, outQty));
    valueMinor = -valueMinor;                            // signed: issue reduces value
  }

  const [move] = await tx.insert(stockMovements).values({
    orgId: input.orgId, itemId: input.itemId, warehouseId: input.warehouseId,
    moveDate: input.moveDate, quantity: input.quantity, valueMinor,
    unitCostMinor, source: input.source,
    sourceDocumentId: input.sourceDocumentId ?? null, jeId: input.jeId ?? null,
    memo: input.memo ?? null, createdByUserId: input.userId ?? null,
  }).returning({ id: stockMovements.id });

  await bumpLevel(tx, level, qty, valueMinor);           // on_hand += qty; value += valueMinor

  return { movementId: move.id, valueMinor, unitCostMinor };
}
```

### 3.3 Valuation — the only subtle part

**Weighted-average (default).** Keep running `value_minor` and `on_hand_qty` on
`item_stock_levels`. On issue of `q` units when the level holds `(V, Q)`:

```
issueValue = round( V * q / Q )     // bigint; proportional, rounds to paise
newValue   = V - issueValue         // residue stays in remaining stock → identity holds
newQty     = Q - q
unitCost   = issueValue / q         // reported only
```

Because we subtract *exactly* `issueValue` (not `unitCost * q`), the cached value
never drifts from `Σ movements`, so the §0(3) identity is exact. Implement
`round(V*q/Q)` on scaled-integer quantities:

```ts
// q, Q are quantities scaled to integer paise-of-quantity (×10_000).
function mulDivRound(V: bigint, qScaled: bigint, QScaled: bigint): bigint {
  const num = V * qScaled;
  const half = QScaled / 2n;
  return (num + half) / QScaled;    // round-half-up; QScaled > 0 guaranteed by lock
}
```

**FIFO (Milestone 1b).** On receipt, open a `stock_layers` row. On issue, consume
oldest layers until `q` is satisfied; `issueValue = Σ(consumed_qty × layer_unit_cost)`,
each term integer, decrementing `remaining_qty`. Partial layers are left with the
residual. WA cached level is still maintained (so reads and the identity are
uniform across methods).

### 3.4 Numbering

Extend `claimNextNumber`'s type union in `ledger.ts`:

```ts
documentType: "invoice" | "bill" | "payment" | "journal"
             | "stock_adjustment" | "stock_transfer",
```

(The sequence rows are seeded by the migration in §2.)

---

## 4. Integration — hooking the money path

### 4.1 Purchase (goods in) — `bills.postBill`

Today every line debits an expense account (`bills.ts:317-335`). Branch so that
**inventory-tracked** lines debit the **Inventory** control account and record a
stock-in instead:

```ts
// inside postBill, replacing the single expenseByAccount loop:
const debitByAccount = new Map<string, bigint>();
const stockIns: Array<{ line: typeof lines[number]; item: Item }> = [];

for (const line of lines) {
  const item = line.itemId ? await getItem(tx, line.itemId) : null;
  if (item?.isInventoryTracked) {
    const invAcct = item.inventoryAccountId
      ?? (await resolveControlAccount(tx, args.orgId, "inventory"));
    debitByAccount.set(invAcct, (debitByAccount.get(invAcct) ?? 0n) + line.lineTotalMinor);
    stockIns.push({ line, item });
  } else {
    const acct = line.expenseAccountId
      ?? (await resolveControlAccount(tx, args.orgId, "operating_expense"));
    debitByAccount.set(acct, (debitByAccount.get(acct) ?? 0n) + line.lineTotalMinor);
  }
}
// …build debit() postings from debitByAccount exactly as before, then post the JE…

// AFTER postJournalEntry returns `entry`, record the goods movements in the same tx:
for (const { line, item } of stockIns) {
  const qty = line.quantity;                              // decimal string, positive
  const unitCost = divCostByQty(line.lineTotalMinor, qty); // paise per unit (excl. tax)
  await postStockMovement({
    orgId: args.orgId, itemId: item.id,
    warehouseId: line.warehouseId ?? (await defaultWarehouseId(tx, args.orgId)),
    moveDate: bill.billDate, quantity: qty, unitCostMinor: unitCost,
    source: "purchase", sourceDocumentId: bill.id, jeId: entry.entryId,
    userId: args.userId,
  }, tx);
}
```

The JE still balances (Dr Inventory/Expense + Dr Input tax = Cr AP) — only the
*account* of the debit changed for tracked items. Stock value entering the ledger
equals the Inventory debit, so the identity holds.

### 4.2 Sale (goods out + COGS) — `invoicing.postInvoice`

Append a **COGS pair** to the same invoice JE (`invoicing.ts`, after the revenue
& tax postings are built, before `postJournalEntry`). Cost comes from valuation,
so it must be computed *before* posting the JE but *applied to stock* after —
resolve by computing issue value first, then recording the movement with the
returned `jeId`:

```ts
// 1) Pre-compute COGS per tracked line (dry-run valuation is fine; we re-run at
//    move time under the same row lock, so recompute-then-move is authoritative).
let cogsTotal = 0n;
const stockOuts: Array<{ line: typeof lines[number]; item: Item }> = [];
for (const line of lines) {
  const item = line.itemId ? await getItem(tx, line.itemId) : null;
  if (item?.isInventoryTracked) stockOuts.push({ line, item });
}

// 2) Record the issues FIRST (they lock the level and return the authoritative
//    value), accumulating COGS, then add the balanced COGS pair to the JE.
//    Because postStockMovement needs a jeId, split: post movements with jeId=null,
//    then post the JE, then backfill jeId. OR (preferred) compute value via a
//    read-only valuation, post the JE, then post movements. Choose ONE:

//  --- preferred: value, post JE (with COGS lines), then move stock ---
for (const { line, item } of stockOuts) {
  const v = await valueIssue(tx, args.orgId, item, line.warehouseId, line.quantity); // no write
  cogsTotal += v.valueMinor;
}
if (cogsTotal > 0n) {
  const cogsAcct = await resolveControlAccount(tx, args.orgId, "cost_of_goods_sold");
  const invAcct  = await resolveControlAccount(tx, args.orgId, "inventory");
  postings.push(debit(cogsAcct, cogsTotal, { memo: `COGS — ${invoice.invoiceNumber}` }));
  postings.push(credit(invAcct, cogsTotal, { memo: `Stock out — ${invoice.invoiceNumber}` }));
}

const entry = await postJournalEntry({ /* …unchanged… */, lines: postings }, tx);

for (const { line, item } of stockOuts) {
  await postStockMovement({
    orgId: args.orgId, itemId: item.id,
    warehouseId: line.warehouseId ?? (await defaultWarehouseId(tx, args.orgId)),
    moveDate: invoice.invoiceDate, quantity: `-${line.quantity}`,
    source: "sale", sourceDocumentId: invoice.id, jeId: entry.entryId,
    userId: args.userId,
  }, tx);
}
```

> **Consistency note:** `valueIssue` (read-only) and `postStockMovement` (write)
> must value identically. Under WA both read the same locked `(V,Q)`; take the row
> lock in `valueIssue` and hold it through the move so no interleaving sale can
> change `(V,Q)` between valuation and posting. In practice the whole thing is one
> `withOrg` transaction, so a single `SELECT … FOR UPDATE` at the top of the COGS
> block is sufficient.

### 4.3 POS — `pos.checkout`

POS already creates + posts + pays an invoice. Because the COGS/stock logic lives
inside `postInvoice`, **POS gets it for free** — no change beyond passing a
`warehouseId` (default warehouse if the till isn't location-aware).

### 4.4 Void / reverse — restock

`invoicing.voidInvoice` / `bills.voidBill` already `reverseJournalEntry`. Add a
compensating stock movement so goods return to (or leave) stock:

```ts
// in voidInvoice, after the reversing JE:
const outs = await tx.select().from(stockMovements)
  .where(and(eq(stockMovements.sourceDocumentId, invoice.id),
             eq(stockMovements.source, "sale")));
for (const m of outs) {
  await postStockMovement({
    orgId, itemId: m.itemId, warehouseId: m.warehouseId,
    moveDate: today, quantity: negate(m.quantity),   // was -5 → restock +5
    unitCostMinor: m.unitCostMinor,                  // restore at the cost it left
    source: "reversal", sourceDocumentId: invoice.id, jeId: reversingEntryId, userId,
  }, tx);
}
```

Restoring at the exact cost it left preserves the identity across the void.

---

## 5. Manual vouchers (Milestone 1c)

`src/server/inventory.ts` additionally exports:

- `recordOpeningStock({ orgId, warehouseId, lines[] })` — for each item posts a
  `+qty` movement at a stated cost, and one JE **Dr Inventory / Cr Opening Balance
  Equity** (subtype `equity`, a system account) for the total. Source
  `opening_balance`.
- `postStockAdjustment({ orgId, warehouseId, lines[], reason })` — write-up or
  write-down of quantity/value. JE: shortfall → **Dr Inventory Shrinkage
  (operating_expense) / Cr Inventory**; surplus → reverse. Number via
  `claimNextNumber(tx, org, "stock_adjustment")`. Source `adjustment`.
- `postStockTransfer({ orgId, fromWarehouseId, toWarehouseId, lines[] })` — two
  movements (`transfer_out` at current cost, `transfer_in` at same cost),
  **no JE** (value doesn't leave the Inventory account, only relocates). Number
  via `stock_transfer`.

---

## 6. Reports (Milestone 1d) — extend `src/server/reports.ts`

- `getStockSummary(orgId, asOf, { warehouseId? })` → per item: on-hand, value,
  average cost. Pure `SUM` over `stock_movements` up to `asOf` (as-of discipline,
  like the aging reports).
- `getStockValuation(orgId, asOf)` → total inventory value; **assert it equals the
  Inventory control-account balance** and surface any drift.
- `getStockMovement(orgId, itemId, from, to)` → item ledger (running balance).
- `getReorderList(orgId)` → items where on-hand < `reorderLevel`.

UI: Inventory screen shows real On-hand / Value / Avg cost columns; add Warehouses
CRUD, Stock Adjustment, Stock Transfer, and an item Stock-Ledger drill-down.

---

## 7. Tests & verification

### 7.1 `src/db/test-ledger.ts` — new rejection/behaviour cases
- Issue more than on-hand → `NEGATIVE_STOCK` (with `allowNegative:false`).
- WA: buy 10@100, buy 10@200, sell 5 → COGS 750 (avg 150), value left 2250. ✅
- FIFO: same buys, sell 15 → COGS = 10×100 + 5×200 = 2000. ✅
- Zero-qty move rejected (`STOCK_ZERO_QTY`).
- Void a posted invoice → stock returns to prior on-hand and value.
- Service item (untracked) sale posts **no** stock movement and **no** COGS.

### 7.2 `src/db/verify.ts` — new integrity identities
- `Σ stock_movements.value_minor (per item)` == `Σ item_stock_levels.value_minor`.
- `Σ item_stock_levels.value_minor (all items)` == balance of the `inventory`
  control account. **This is the headline invariant.**
- No `item_stock_levels` row has negative value; none has negative on-hand unless
  the org allows it.
- Every `sale`/`purchase` movement has a non-null `jeId`.

### 7.3 Seed (`src/db/seed.ts`)
- Create `Main Warehouse`; mark demo goods `isInventoryTracked`.
- Load opening stock via `recordOpeningStock` (not direct inserts).
- Existing seeded bills → now generate stock-in; seeded invoices → stock-out+COGS,
  so the demo P&L finally shows a real gross margin.

---

## 8. Rollout checklist

1. [ ] Schema: enums, `items`/`invoice_lines`/`bill_lines` alters, 4 new tables.
2. [ ] `bun run db:generate` → hand-append RLS/grants/seed block → `db:migrate`.
3. [ ] `inventory.ts`: `postStockMovement`, WA valuation, level lock/bump, masters.
4. [ ] Extend `claimNextNumber` union + seed sequences.
5. [ ] Hook `postBill` (stock-in) and `postInvoice` (COGS + stock-out); POS is free.
6. [ ] Void/reverse restock in `voidInvoice`/`voidBill`.
7. [ ] `db:test` cases green; `db:verify` identity green.
8. [ ] Milestone 1b: `stock_layers` + FIFO.
9. [ ] Milestone 1c: opening / adjustment / transfer vouchers.
10. [ ] Milestone 1d: reports + Inventory/Warehouse UI + API routes
        (`src/api/inventory.ts`, mirror `src/api/entities.ts`).

## 9. Decisions locked (change here if you disagree)

- **Default valuation = weighted-average**, per-item FIFO opt-in. (Tally default is
  a form of WA; FIFO is common for perishables.)
- **COGS rides the sale's own journal entry** (one voucher per sale) rather than a
  separate inventory JE — simpler audit, still atomic.
- **Negative stock rejected by default**, opt-in per call/org. (Tally warns; we
  refuse unless allowed, matching Monarch's fail-closed posture.)
- **Warehouse is per line**, defaulting to the org's default godown, so
  single-location orgs never see the concept.
- **Transfers post no JE** (value stays in the Inventory account); only
  adjustments and opening balances touch money.
