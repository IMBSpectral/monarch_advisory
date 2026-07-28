# Monarch → Tally-Parity Development Plan

> Scope: bring the Monarch platform up to feature parity with Tally, **excluding
> statutory compliance** (GST filing/GSP, e-invoicing/IRN, e-way bills, TDS
> returns) and **live external feeds** (bank aggregators, payment gateways),
> which are tracked separately.

## Context — why this is cheaper than it looks

Two facts about the existing ledger core make several features "finish the
wiring" rather than "build from zero":

- `PostingLine` (in `src/server/ledger.ts`) **already carries `costCenterId` and
  `projectId`** — the ledger is pre-wired for dimensional accounting.
- `claimNextNumber(orgId, documentType)`, `resolveControlAccount(subtype)`, and
  `reverseJournalEntry()` already exist — every new voucher type reuses the exact
  `createX → postX → recordPayment/void` triad that `invoicing.ts` and `bills.ts`
  already follow.

The `items` master is already wired with `inventoryAccountId`,
`purchaseAccountId`, and an `isInventoryTracked` flag — COGS accounts are in
place; nothing moves stock yet.

## Guiding principles (apply to every phase)

1. **One posting path.** Every document that touches money ultimately calls
   `postJournalEntry`. If it touches money, it produces a balanced JE — no
   exceptions.
2. **Mirror the proven triad.** Each new transactional entity copies the shape of
   `invoicing.ts`: `createX()` (draft) → `postX()` (commit + JE) →
   `recordPayment/void/reverse`.
3. **RLS on every financial table.** New tables get `org_id` + `FORCE ROW LEVEL
SECURITY` in the same migration, following migrations 0002/0003.
4. **Immutable + reverse, never edit.** Corrections use `reverseJournalEntry`,
   exactly as invoices do today.
5. **Integer paise, `money()` columns, `claimNextNumber` for every document
   series.**
6. **Extend `db:test`** with rejection tests for each new invariant, and
   `db:verify` for each new reconciliation identity.

---

## Phase 0 — Shared foundations (1 week)

Small enablers the later phases depend on.

- **Master dimension tables** (RLS): `costCenters`, `projects`. The
  `costCenterId`/`projectId` columns already exist on `journalLines`; this adds
  the lookup tables + FKs.
- **Numbering series**: register new `document_type` values in
  `documentSequences` (`CN`, `DN`, `SO`, `PO`, `DC`, `GRN`, `CONTRA`, `STJ`).
- **UoM table** (`unitsOfMeasure`) to replace the free-text `unit_of_measure`,
  with compound-unit support (e.g. BOX = 12 PCS).

---

## Phase 1 — Inventory / Stock Ledger engine ⭐ biggest (4–6 weeks)

The defining gap. Build a **perpetual stock ledger** parallel to the financial
ledger.

**Schema**

- `stockMovements` — the stock analogue of `journalLines`:
  `(orgId, itemId, warehouseId, moveDate, qtyIn, qtyOut, rateMinor, valueMinor,
sourceType, sourceDocId, jeId)`. Immutable, RLS.
- `warehouses` (godowns) — back the existing UI screen with a real table.
- `itemStockLevels` — materialized on-hand qty + value per (item, warehouse),
  rebuilt from movements (same pattern as cached balances, with a verify check).
- Optional now / stub later: `stockBatches`, `serialNumbers`.

**Server (`src/server/inventory-ledger.ts`)**

- `postStockMovement(tx, {...})` — the stock chokepoint. Called inside the same DB
  transaction as `postJournalEntry`.
- **Valuation engine**: `computeIssueCost(itemId, warehouseId, qty, method)`
  supporting **Weighted-Average (default) and FIFO**. FIFO consumes a
  `stockLayers` table; WA reads running value/qty.
- **COGS hook**: when a tracked item is sold (invoice post / POS checkout),
  `postInvoice` additionally posts **Dr COGS / Cr Inventory** at computed cost.
  The item schema is already wired; connect it.

**Integration points** (modify, don't fork)

- `invoicing.postInvoice` → add stock-out + COGS JE for tracked lines.
- `bills.postBill` → add stock-in movement at purchase rate.
- `pos.checkout` → same as invoice.

**UI**: Inventory screen gains real on-hand/valuation columns; new **Stock
Journal** (adjustments), **Stock Transfer** (warehouse↔warehouse), physical-stock
verification.

**Tests**: negative-stock rejection, WA/FIFO valuation correctness, "inventory
account balance == Σ stock value" in `db:verify`.

---

## Phase 2 — Voucher & order lifecycle (4–5 weeks)

> **STATUS (2026-07-22): Phase 2 backend COMPLETE.** Credit/Debit Notes
> (`credit-notes.ts`, mig 0005), Contra + Sales/Purchase Orders (`contra.ts`,
> `orders.ts`, mig 0006), and Delivery Note / GRN (`receipts.ts`, mig 0007) all
> shipped with tests. GRN posts `Dr Inventory / Cr GRNI` (clearing account 2150,
> new `goods_received_clearing` subtype); its bill posts `Dr GRNI / Cr A/P` via a
> `bills.stockReceived` flag. Delivery posts `Dr COGS / Cr Inventory`; its invoice
> recognises revenue only via an `invoices.stockRelieved` flag. Every flow keeps
> `stock == inventory account`. `db:test` = **72 passing**, `db:verify` 6/6.
> **UI SHIPPED (2026-07-22):** `src/api/vouchers.ts` + 7 routes (credit/debit
> notes, contra, sales/purchase orders, GRN, delivery) + shared `LinesEditor`,
> all wired into the sidebar. List + create-dialog + convert actions verified
> live (SO→invoice and a contra transfer both posted; `db:verify` still 6/6 after
> UI-driven transactions). **Phase 2 COMPLETE — backend + UI.**

Complete Tally's voucher set. Each reuses the triad + `claimNextNumber`.

| Voucher                          | Schema                                    | Posting model                                                                             | Notes                                                    |
| -------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Credit Note** (sales return)   | `creditNotes` + lines                     | Reverse-direction of invoice: Dr Revenue+GST / Cr Receivables; stock-in if goods returned | Build on `reverseJournalEntry` semantics                 |
| **Debit Note** (purchase return) | `debitNotes` + lines                      | Mirror for bills                                                                          |                                                          |
| **Contra**                       | reuse `journalEntries` w/ source=`contra` | Cash↔Bank / Bank↔Bank transfer, 2-line JE                                                 | Thin — mostly UI                                         |
| **Sales Order / Purchase Order** | `salesOrders`/`purchaseOrders` + lines    | **No JE** (non-financial commitment) → converts to invoice/bill                           | Adds fulfilment status tracking                          |
| **Delivery Note / GRN**          | `deliveryNotes`/`goodsReceipts`           | Stock movement only (no financial JE until invoice/bill)                                  | Splits goods flow from money flow — core Tally behaviour |
| **Quote/Estimate**               | `quotes`                                  | None → converts to SO/invoice                                                             |                                                          |

**UI**: an "order → delivery → invoice" pipeline on Sales; "PO → GRN → bill" on
Purchases, each showing conversion status.

---

## Phase 3 — Reporting completion (2–3 weeks)

> **STATUS (2026-07-22): core reports SHIPPED.** `reports.ts` gained
> `getPayablesAging` (nets debit notes; verify asserts it == A/P control),
> `getDayBook`, and `getCashFlow` (direct method — classifies each cash entry's
> counterpart legs, so it always reconciles to Δcash; verify asserts it). API
> fetchers in `src/api/index.ts`; 4 UI pages (`reports.payables-aging`,
> `reports.cash-flow`, `reports.day-book`, `reports.stock`) wired into the
> `/reports` hub. `db:verify` now **8/8**. Verified live in the app.
> **Remaining:** group/ledger summary, ratio analysis, multi-period comparatives,
> cost-center P&L (waits on Phase 4 dimensions).

Extend `src/server/reports.ts` (already has TB, P&L, BS, AR-aging,
account-ledger).

- **Payables Aging** (mirror `getReceivablesAging`).
- **Day Book** (all vouchers for a date range — trivial ledger query).
- **Cash Flow & Funds Flow** statements (indirect method from JE deltas).
- **Group/Ledger Summary** (roll-up by account subtype/group).
- **Cost-Center / Project P&L** (group JE by the dimension columns — data captured
  once Phase 4 populates them).
- **Stock reports**: Stock Summary, Movement Analysis, valuation report (from
  Phase 1 movements).
- **Ratio analysis** + **multi-period comparatives** (P&L/BS side-by-side).
- UI: a **Reports** hub replacing the current stub, each with date filters + CSV
  export (reuse `src/lib/export.ts`).

---

## Phase 4 — Dimensions, budgets & credit control (2–3 weeks)

> **STATUS (2026-07-22): core SHIPPED.** Cost centres & projects master tables
> (mig 0008) with `getCostCenterPnl` + `/reports/cost-center-pnl` + `/accounting/
cost-centers` UI + a working manual-JE endpoint that tags them. Budgets (mig 0009) with `getBudgetVsActual` + `/reports/budget`. Credit-limit enforcement in
> `postInvoice` (blocks when receivable + invoice > `contacts.creditLimitMinor`,
> `allowCreditOverride` for accountants) with 2 tests. `db:test` = **74**,
> `db:verify` 8/8. Verified live. **Remaining:** interest on overdue, per-voucher
> dimension tagging in the sales/purchase dialogs, mandatory-CC enforcement.

- **Cost centers / projects**: expose the _already-existing_
  `costCenterId`/`projectId` on every voucher line UI; enforce optional/mandatory
  per account. Reports come free from Phase 3.
- **Budgets**: `budgets` table (per account/cost-center/period) + budget-vs-actual
  report.
- **Credit-limit enforcement**: the `credit_limit` field on contacts exists —
  enforce at `postInvoice` (block/warn when outstanding + new > limit, gated by
  role capability).
- **Interest on overdue**: scheduled calc producing debit notes / JEs for overdue
  receivables.

---

## Phase 5 — Multi-currency operationalization (2 weeks)

> **STATUS (2026-07-22): core SHIPPED.** `exchange_rates` master (mig 0010) with
> `src/api/forex.ts` (fetch/upsert rates) + `/accounting/exchange-rates` UI.
> Foreign-currency accounts (seed adds an `SVB USD Account` pinned to USD, funded
> $10k @ ₹83, carrying its foreign + base balances via `original_amount_minor`).
> **Forex revaluation** — `src/server/forex.ts` `getForexExposure` +
> `postForexRevaluation` (trues base carrying to `foreign × latest rate`, books the
> net to a system `Forex Gain/Loss` account, source `fx_revaluation`); report +
> post action at `/reports/forex`. `db:test` = **78** (+4), `db:verify` 8/8.
> Verified live (USD revalued ₹83→₹86.5 = ₹35k gain, posted, exposure cleared).
> **Remaining:** foreign-currency _invoices/bills_ (needs AR/AP aging to convert,
> which risks the control==subledger invariant — deliberately deferred), realized
> forex gain/loss on settlement, rate auto-fetch.

Schema is already scaffolded (`baseCurrency`, per-line `currency`/`exchangeRate`/
`originalAmountMinor`).

- `exchangeRates` table + rate-fetch/entry UI.
- Foreign-currency invoices/bills/payments populate the original-amount fields
  (plumbing exists in `PostingLine`).
- **Forex gain/loss**: on settlement at a different rate, post the delta to a
  "Forex Gain/Loss" account.

---

## Phase 6 — Fixed assets & depreciation (1–2 weeks)

> **STATUS (2026-07-22): SHIPPED.** `fixed_assets` + `depreciation_entries` (mig
> 0011). `src/server/assets.ts`: `createFixedAsset` (optional acquisition posting,
> auto-resolves accum/dep accounts by subtype), `runDepreciation` (straight-line,
> one JE/run, one entry/asset-month, idempotent), `disposeFixedAsset` (removes
> cost + accumulated, books gain/loss), `getAssetRegister`, `getTotalDepreciation`
> (active assets only). `src/api/assets.ts` + `/accounting/fixed-assets` UI
> (register + Run depreciation + New Asset + Dispose dialogs). Seed adds 2 assets
> depreciated through July (₹1.6L). `db:verify` **9/9** (added accum-dep ==
> register), `db:test` **83** (+5). Verified live: register, depreciation totals,
> and a disposal booking a ₹20k gain. **Remaining:** WDV/declining-balance method,
> partial-month/pro-rata, revaluation of assets.

Depreciation **account types already exist**; add the engine.

- `fixedAssets` + `depreciationSchedules` tables.
- Monthly/quarterly depreciation run → posts Dr Depreciation Expense / Cr
  Accumulated Depreciation via `postJournalEntry`.
- Asset register report; disposal handling (gain/loss on sale).

---

## Phase 7 — Period management & consolidation (2 weeks)

> **STATUS (2026-07-22): SHIPPED.** `src/server/period.ts`: `closePeriod` (zeroes
> income/expense into Retained Earnings, sets `booksClosedThrough`), `reopenPeriod`
> (lifts the lock + reverses the roll-up, audited reason), `getPeriodStatus`.
> `src/api/period.ts` adds those + `fetchConsolidation` (aggregates every org the
> user is a member of — each read in its own `withOrg`, so RLS holds per-entity).
> UI: `/accounting/period-close` (status + close + reopen) and
> `/reports/consolidation` (per-entity + consolidated totals). Seed makes the
> founder an admin of the empty second org so consolidation shows two entities.
> `db:test` = **89** (+6), `db:verify` 9/9. Verified live. **Remaining:** intercompany
> eliminations, per-FY split/carry-forward beyond the single roll-up.

- **Year-end close**: lock a fiscal period (no posting to closed periods — a guard
  in `postJournalEntry`), roll P&L into Retained Earnings, carry balances forward.
- **Period lock** table + capability check.
- **Multi-org consolidation** report: aggregate across the tenant's orgs
  (owner-only, respecting RLS via the admin path).

---

## Phase 8 — Automation, documents, banking & data ops (3–4 weeks)

> **STATUS (2026-07-22): self-contained core SHIPPED.** Recurring invoices —
> `recurring_templates`/`_lines` (mig 0012), `src/server/recurring.ts`
> (`createRecurringTemplate`, `generateDueInvoices` — catches up every missed
> period at once, advances next-run, ends on end-date), `src/api/recurring.ts`,
> `/sales/recurring` UI (list + create + "Generate due"). Bank-statement import —
> `src/api/banking.ts` (`importBankStatementFn` into `bank_transactions`,
> deduped on the `(bankAccountId, externalId)` unique index), `/banking/import`
> UI (paste CSV → parse → import). `db:test` = **92** (+3), `db:verify` 9/9.
> Verified live (generated 2 catch-up invoices; imported 3 statement lines).
> **Deferred (external / infra):** payment-reminder emails, live bank feeds,
> cheque printing, backup/restore, bulk import, third-party API — these need
> external services or ops tooling out of app scope.

- **Payment reminders**: scheduled job over AR-aging → email/notification (needs
  an email provider — external).
- **Banking**: bank-statement **import** (CSV/OFX) into `bankTransactions`; cheque
  printing/register; post-dated cheque tracking. (Live aggregator feed stays out —
  external.)
- **Documents**: invoice/voucher **template customization**, email send, bulk
  print.
- **Data ops**: **backup/restore** (pg_dump orchestration + restore UI), **bulk
  import** (customers/items/opening balances via CSV), and an **API layer** for
  third-party access.

---

## Phase 9 — Payroll (optional, 3–4 weeks)

Largest non-accounting module; only if targeting full Tally parity.

- `employees`, `salaryStructures`, `attendance`, `payrollRuns` → each run posts
  salary JEs (Dr Salaries / Cr Bank + statutory payables). PF/ESI/PT computation
  is compliance-adjacent (deferred with the other statutory work).

---

## Sequencing & effort summary

| Phase | Feature                               | Effort | Depends on |
| ----- | ------------------------------------- | ------ | ---------- |
| 0     | Foundations (dimensions, UoM, series) | 1 wk   | —          |
| 1     | **Inventory / stock ledger + COGS**   | 4–6 wk | 0          |
| 2     | Voucher & order lifecycle             | 4–5 wk | 1          |
| 3     | Reporting completion                  | 2–3 wk | 1, 2       |
| 4     | Dimensions, budgets, credit control   | 2–3 wk | 0, 3       |
| 5     | Multi-currency                        | 2 wk   | —          |
| 6     | Fixed assets / depreciation           | 1–2 wk | —          |
| 7     | Period close & consolidation          | 2 wk   | 3          |
| 8     | Automation, docs, banking, data ops   | 3–4 wk | 2, 3       |
| 9     | Payroll (optional)                    | 3–4 wk | 8          |

**Roughly 5–7 months for one strong full-stack engineer** to reach broad Tally
parity (excluding statutory compliance and live external feeds); ~half that with
two engineers running inventory (Phase 1–2) and reporting/dimensions (Phase 3–4)
in parallel, since they share only the ledger interface.

**Critical path is Phase 1 → 2 → 3.** Everything else (5, 6, 8) can slot in
parallel because they each touch the ledger only through `postJournalEntry` and
their own tables.

The single highest-leverage move is **Phase 1**: once the stock ledger + COGS
exist, inventory valuation, stock reports, delivery/GRN, and accurate
gross-margin P&L all unlock together.

---

## Out of scope (tracked separately)

- **Statutory compliance**: GST return filing via GSP, e-invoicing (IRN/QR),
  e-way bills, TDS deduction & returns.
- **Live external integrations**: bank account aggregator feeds, payment gateways.
- **Certifications**: HIPAA / PCI / GDPR.
