/**
 * Inventory — the perpetual stock ledger and its valuation.
 *
 * This is to goods what `ledger.ts` is to money. Two rules govern it:
 *
 * 1. STOCK MOVES RIDE ON MONEY MOVES. A purchase records stock-in in the same
 *    transaction as the bill's journal entry; a sale records stock-out (and the
 *    COGS posting) in the same transaction as the invoice's. Goods and money are
 *    never allowed to disagree, because they are written atomically.
 *
 * 2. THE INVENTORY ACCOUNT EQUALS THE STOCK VALUE, ALWAYS. Every movement puts
 *    the exact same integer into `stock_movements.value_minor` that the journal
 *    entry puts into the Inventory control account. Their sums can therefore
 *    never drift — `db:verify` asserts it.
 *
 * Valuation is weighted-average (Phase 1a). On issue, cost = value × qty ÷ onHand,
 * rounded to the paise, with the residue left in remaining stock so the identity
 * above holds exactly.
 */

import { and, eq, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import { parseQuantity } from "@/lib/decimal";
import { itemStockLevels, items, stockLayers, stockMovements, warehouses } from "@/db/schema";
import {
  LedgerError,
  credit,
  debit,
  postJournalEntry,
  resolveControlAccount,
  writeAudit,
} from "./ledger";

/* ────────────────────────────────────────────────────────────────────────────
 * Quantity math — 4-decimal fixed point on bigint, no floats in the hot path
 * ──────────────────────────────────────────────────────────────────────────*/

const QTY_SCALE = 10_000n;

/** Parse a decimal quantity string ("2.5") to a scaled bigint (25000 = 2.5). */
export function toScaledQty(qty: string): bigint {
  try {
    // Exact string parse — no float, so 0.0001 and very large quantities are
    // preserved rather than rounded by IEEE-754.
    return parseQuantity(qty);
  } catch {
    throw new LedgerError(`Invalid quantity "${qty}".`, "INVALID_QUANTITY");
  }
}

/** Render a scaled bigint quantity back to a 4dp decimal string. */
export function fromScaledQty(scaled: bigint): string {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const whole = abs / QTY_SCALE;
  const frac = (abs % QTY_SCALE).toString().padStart(4, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Round-half-up bigint mul/div. Same convention as invoicing/bills tax math. */
function mulDivRound(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scaled = abs * numerator;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Warehouses
 * ──────────────────────────────────────────────────────────────────────────*/

/** The org's default godown. Callers that don't care about location use this. */
export async function getDefaultWarehouseId(tx: DbOrTx, orgId: string): Promise<string> {
  const [wh] = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.orgId, orgId), eq(warehouses.isDefault, true)))
    .limit(1);
  if (wh) return wh.id;

  // No default yet (e.g. an org created before this feature) — make one.
  const [created] = await tx
    .insert(warehouses)
    .values({ orgId, code: "MAIN", name: "Main Warehouse", isDefault: true })
    .returning({ id: warehouses.id });
  return created.id;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Level access
 * ──────────────────────────────────────────────────────────────────────────*/

type LevelSnapshot = { qtyScaled: bigint; valueMinor: bigint };

/**
 * Lock (and create if absent) the level row for one (item, warehouse), returning
 * its current on-hand and value. The `FOR UPDATE` lock is held to end of the
 * enclosing transaction, which is what serialises concurrent issues of the same
 * item — two sales can't both value against the same pre-depletion stock.
 */
async function lockLevel(
  tx: DbOrTx,
  orgId: string,
  itemId: string,
  warehouseId: string,
): Promise<LevelSnapshot> {
  await tx
    .insert(itemStockLevels)
    .values({ orgId, itemId, warehouseId, onHandQty: "0", valueMinor: 0n })
    .onConflictDoNothing();

  const rows = (await tx.execute(sql`
    select on_hand_qty, value_minor
    from item_stock_levels
    where item_id = ${itemId} and warehouse_id = ${warehouseId}
    for update
  `)) as unknown as Array<{ on_hand_qty: string; value_minor: string }>;

  const row = rows[0];
  return { qtyScaled: toScaledQty(row.on_hand_qty), valueMinor: BigInt(row.value_minor) };
}

/** An item's valuation method ('weighted_average' | 'fifo'). */
async function itemMethod(tx: DbOrTx, orgId: string, itemId: string): Promise<string> {
  const [item] = await tx
    .select({ method: items.valuationMethod })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.orgId, orgId)))
    .limit(1);
  return item?.method ?? "weighted_average";
}

type FifoLayer = { id: string; remainingScaled: bigint; remainingValueMinor: bigint };

/** Lock and load a FIFO item's remaining layers, oldest first. */
async function lockFifoLayers(
  tx: DbOrTx,
  orgId: string,
  itemId: string,
  warehouseId: string,
): Promise<FifoLayer[]> {
  const rows = (await tx.execute(sql`
    select id, remaining_qty, remaining_value_minor
    from stock_layers
    where org_id = ${orgId} and item_id = ${itemId} and warehouse_id = ${warehouseId} and remaining_qty > 0
    order by received_at, created_at
    for update
  `)) as unknown as Array<{ id: string; remaining_qty: string; remaining_value_minor: string }>;
  return rows.map((r) => ({
    id: r.id,
    remainingScaled: toScaledQty(r.remaining_qty),
    remainingValueMinor: BigInt(r.remaining_value_minor),
  }));
}

async function writeLevel(
  tx: DbOrTx,
  itemId: string,
  warehouseId: string,
  next: LevelSnapshot,
): Promise<void> {
  await tx
    .update(itemStockLevels)
    .set({
      onHandQty: fromScaledQty(next.qtyScaled),
      valueMinor: next.valueMinor,
      updatedAt: new Date(),
    })
    .where(and(eq(itemStockLevels.itemId, itemId), eq(itemStockLevels.warehouseId, warehouseId)));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Movement primitive
 * ──────────────────────────────────────────────────────────────────────────*/

type MovementArgs = {
  orgId: string;
  itemId: string;
  warehouseId: string;
  moveDate: string;
  /** Signed scaled quantity: + received, − issued. */
  qtyScaled: bigint;
  /** Signed value paise: + in, − out. */
  valueMinor: bigint;
  unitCostMinor: bigint;
  source: (typeof stockMovements.$inferInsert)["source"];
  sourceDocumentId?: string | null;
  jeId?: string | null;
  userId?: string | null;
  memo?: string | null;
  allowNegative?: boolean;
};

/**
 * Write one signed stock movement and roll the cached level forward.
 * The lowest-level operation; higher-level receive/issue helpers build on it.
 */
async function postMovement(tx: DbOrTx, m: MovementArgs): Promise<void> {
  if (m.qtyScaled === 0n) {
    throw new LedgerError("Zero-quantity stock move.", "STOCK_ZERO_QTY");
  }
  const level = await lockLevel(tx, m.orgId, m.itemId, m.warehouseId);
  const nextQty = level.qtyScaled + m.qtyScaled;
  const nextValue = level.valueMinor + m.valueMinor;

  if (nextQty < 0n && !m.allowNegative) {
    throw new LedgerError(
      `Insufficient stock for item ${m.itemId}: on hand ${fromScaledQty(level.qtyScaled)}, ` +
        `move ${fromScaledQty(m.qtyScaled)}.`,
      "NEGATIVE_STOCK",
    );
  }

  await tx.insert(stockMovements).values({
    orgId: m.orgId,
    itemId: m.itemId,
    warehouseId: m.warehouseId,
    moveDate: m.moveDate,
    quantity: fromScaledQty(m.qtyScaled),
    valueMinor: m.valueMinor,
    unitCostMinor: m.unitCostMinor,
    source: m.source,
    sourceDocumentId: m.sourceDocumentId ?? null,
    jeId: m.jeId ?? null,
    memo: m.memo ?? null,
    createdByUserId: m.userId ?? null,
  });

  await writeLevel(tx, m.itemId, m.warehouseId, { qtyScaled: nextQty, valueMinor: nextValue });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Receive (goods in)
 * ──────────────────────────────────────────────────────────────────────────*/

export type ReceiveInput = {
  orgId: string;
  itemId: string;
  warehouseId: string;
  moveDate: string;
  /** Decimal quantity string, positive. */
  quantity: string;
  /** Total value of this receipt in paise. Unit cost is derived for display. */
  valueMinor: bigint;
  source?: (typeof stockMovements.$inferInsert)["source"];
  sourceDocumentId?: string | null;
  jeId?: string | null;
  userId?: string | null;
  memo?: string | null;
};

/**
 * Record goods entering stock at a known total value (the purchase cost, or an
 * opening balance). Value is taken as given — not recomputed from a unit cost —
 * so the stock value moved equals exactly the amount the journal debited to the
 * Inventory account.
 */
export async function receiveStock(tx: DbOrTx, input: ReceiveInput): Promise<void> {
  const qtyScaled = toScaledQty(input.quantity);
  if (qtyScaled <= 0n) {
    throw new LedgerError(
      `Receipt quantity must be positive, got "${input.quantity}".`,
      "INVALID_QUANTITY",
    );
  }
  const unitCost = mulDivRound(input.valueMinor, QTY_SCALE, qtyScaled);
  await postMovement(tx, {
    orgId: input.orgId,
    itemId: input.itemId,
    warehouseId: input.warehouseId,
    moveDate: input.moveDate,
    qtyScaled,
    valueMinor: input.valueMinor,
    unitCostMinor: unitCost,
    source: input.source ?? "purchase",
    sourceDocumentId: input.sourceDocumentId,
    jeId: input.jeId,
    userId: input.userId,
    memo: input.memo,
  });

  // FIFO items track each receipt as a cost layer to be consumed oldest-first.
  if ((await itemMethod(tx, input.orgId, input.itemId)) === "fifo") {
    await tx.insert(stockLayers).values({
      orgId: input.orgId,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      receivedAt: input.moveDate,
      originalQty: input.quantity,
      remainingQty: input.quantity,
      unitCostMinor: unitCost,
      remainingValueMinor: input.valueMinor, // exact, no rounding residue
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Issue (goods out) — plan then commit
 *
 * The COGS amount must be known BEFORE the invoice journal entry is posted (it's
 * a line on that entry), but the movement can only be written AFTER, because it
 * links to the entry id and the app role cannot back-fill it. So issuing is split:
 *   planStockOut   — locks levels, computes weighted-average issue value, no write
 *   commitStockOut — writes the movements, with the entry id, applying the plan
 * The FOR UPDATE locks taken during planning are held until commit (same tx), so
 * nothing can change the stock in between.
 * ──────────────────────────────────────────────────────────────────────────*/

export type IssueRequest = { itemId: string; quantity: string; memo?: string | null };

type PlannedIssue = {
  itemId: string;
  qtyScaled: bigint;
  valueMinor: bigint; // absolute value to remove
  unitCostMinor: bigint;
  memo?: string | null;
  /** For FIFO items: how much qty/value to draw from each layer, applied at commit. */
  fifo?: Array<{ layerId: string; qtyScaled: bigint; valueMinor: bigint }>;
};

export type StockOutPlan = {
  warehouseId: string;
  lines: PlannedIssue[];
  totalValueMinor: bigint;
};

/**
 * Value a set of issues against current stock without writing anything.
 * Threads a running (value, qty) per item so multiple lines of the same item on
 * one document deplete correctly. Throws NEGATIVE_STOCK if an issue exceeds hand.
 */
export async function planStockOut(
  tx: DbOrTx,
  orgId: string,
  warehouseId: string,
  requests: IssueRequest[],
): Promise<StockOutPlan> {
  const running = new Map<string, LevelSnapshot>();
  const fifoRunning = new Map<string, FifoLayer[]>();
  const lines: PlannedIssue[] = [];
  let total = 0n;

  for (const req of requests) {
    const qtyScaled = toScaledQty(req.quantity);
    if (qtyScaled <= 0n) {
      throw new LedgerError(
        `Issue quantity must be positive, got "${req.quantity}".`,
        "INVALID_QUANTITY",
      );
    }

    const method = await itemMethod(tx, orgId, req.itemId);

    if (method === "fifo") {
      // Draw from the oldest layers first, accumulating their cost.
      let layers = fifoRunning.get(req.itemId);
      if (!layers) {
        layers = await lockFifoLayers(tx, orgId, req.itemId, warehouseId);
        fifoRunning.set(req.itemId, layers);
      }
      let need = qtyScaled;
      let value = 0n;
      const consume: Array<{ layerId: string; qtyScaled: bigint; valueMinor: bigint }> = [];
      for (const layer of layers) {
        if (need <= 0n) break;
        if (layer.remainingScaled <= 0n) continue;
        const take = need < layer.remainingScaled ? need : layer.remainingScaled;
        // Draw exact value: the whole layer takes its remaining value; a partial
        // draw takes a proportional slice. This leaves no rounding residue —
        // depleting a layer always zeroes both its qty and its value.
        const takeValue =
          take === layer.remainingScaled
            ? layer.remainingValueMinor
            : mulDivRound(layer.remainingValueMinor, take, layer.remainingScaled);
        value += takeValue;
        layer.remainingScaled -= take;
        layer.remainingValueMinor -= takeValue;
        need -= take;
        consume.push({ layerId: layer.id, qtyScaled: take, valueMinor: takeValue });
      }
      if (need > 0n) {
        throw new LedgerError(
          `Insufficient stock for item ${req.itemId} (FIFO): short by ${fromScaledQty(need)}.`,
          "NEGATIVE_STOCK",
        );
      }
      const unitCost = mulDivRound(value, QTY_SCALE, qtyScaled);
      lines.push({
        itemId: req.itemId,
        qtyScaled,
        valueMinor: value,
        unitCostMinor: unitCost,
        memo: req.memo,
        fifo: consume,
      });
      total += value;
      continue;
    }

    // Weighted-average: proportional slice of the remaining value.
    let level = running.get(req.itemId);
    if (!level) {
      level = await lockLevel(tx, orgId, req.itemId, warehouseId);
      running.set(req.itemId, level);
    }
    if (qtyScaled > level.qtyScaled) {
      throw new LedgerError(
        `Insufficient stock for item ${req.itemId}: on hand ${fromScaledQty(level.qtyScaled)}, ` +
          `issuing ${req.quantity}.`,
        "NEGATIVE_STOCK",
      );
    }
    const issueValue = mulDivRound(level.valueMinor, qtyScaled, level.qtyScaled);
    const unitCost = mulDivRound(issueValue, QTY_SCALE, qtyScaled);
    running.set(req.itemId, {
      qtyScaled: level.qtyScaled - qtyScaled,
      valueMinor: level.valueMinor - issueValue,
    });
    lines.push({
      itemId: req.itemId,
      qtyScaled,
      valueMinor: issueValue,
      unitCostMinor: unitCost,
      memo: req.memo,
    });
    total += issueValue;
  }

  return { warehouseId, lines, totalValueMinor: total };
}

/** Write the movements a plan describes, now that the journal entry exists. */
export async function commitStockOut(
  tx: DbOrTx,
  orgId: string,
  plan: StockOutPlan,
  meta: {
    moveDate: string;
    source: (typeof stockMovements.$inferInsert)["source"];
    sourceDocumentId?: string | null;
    jeId?: string | null;
    userId?: string | null;
  },
): Promise<void> {
  for (const line of plan.lines) {
    await postMovement(tx, {
      orgId,
      itemId: line.itemId,
      warehouseId: plan.warehouseId,
      moveDate: meta.moveDate,
      qtyScaled: -line.qtyScaled,
      valueMinor: -line.valueMinor,
      unitCostMinor: line.unitCostMinor,
      source: meta.source,
      sourceDocumentId: meta.sourceDocumentId,
      jeId: meta.jeId,
      userId: meta.userId,
      memo: line.memo,
    });
    // Draw down the FIFO layers this issue consumed — both qty and exact value.
    for (const c of line.fifo ?? []) {
      await tx.execute(sql`
        update stock_layers
        set remaining_qty = remaining_qty - ${fromScaledQty(c.qtyScaled)},
            remaining_value_minor = remaining_value_minor - ${c.valueMinor},
            updated_at = now()
        where id = ${c.layerId}
      `);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reversal — undo a document's stock effect (for void/reverse)
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Post the mirror image of every movement a document produced. Used when an
 * invoice/bill is voided: the reversing journal entry has already put the money
 * back, and this puts the goods back (or takes them away) by the same values, so
 * the account/stock identity survives the void.
 */
export async function reverseDocumentStock(
  tx: DbOrTx,
  args: {
    orgId: string;
    sourceDocumentId: string;
    moveDate: string;
    jeId?: string | null;
    userId?: string | null;
  },
): Promise<void> {
  const original = await tx
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.orgId, args.orgId),
        eq(stockMovements.sourceDocumentId, args.sourceDocumentId),
      ),
    );

  for (const m of original) {
    if (m.source === "reversal") continue; // don't reverse a reversal
    const reverseQtyScaled = -toScaledQty(m.quantity);
    await postMovement(tx, {
      orgId: args.orgId,
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      moveDate: args.moveDate,
      qtyScaled: reverseQtyScaled,
      valueMinor: -m.valueMinor,
      unitCostMinor: m.unitCostMinor,
      source: "reversal",
      sourceDocumentId: args.sourceDocumentId,
      jeId: args.jeId ?? null,
      userId: args.userId,
      // A reversal must be allowed to drive stock to zero even if some was sold.
      allowNegative: true,
    });
    // Reversing a sale of a FIFO item puts goods back — as a fresh layer at the
    // cost they left. (Reversing a receipt is left to the level; layer drift on
    // that rare path is tolerated since the account/stock identity still holds.)
    if (reverseQtyScaled > 0n && (await itemMethod(tx, args.orgId, m.itemId)) === "fifo") {
      await tx.insert(stockLayers).values({
        orgId: args.orgId,
        itemId: m.itemId,
        warehouseId: m.warehouseId,
        receivedAt: args.moveDate,
        originalQty: fromScaledQty(reverseQtyScaled),
        remainingQty: fromScaledQty(reverseQtyScaled),
        unitCostMinor: m.unitCostMinor,
        remainingValueMinor: -m.valueMinor, // the restocked value (m.valueMinor is negative for a sale)
      });
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Opening stock
 * ──────────────────────────────────────────────────────────────────────────*/

export type OpeningStockLine = { itemId: string; quantity: string; unitCostMinor: bigint };

/**
 * Load opening stock: one journal entry (Dr Inventory / Cr the offset equity
 * account) for the total, plus a receipt per item. Used by the seed and by
 * onboarding an existing business into Monarch.
 */
export async function recordOpeningStock(input: {
  orgId: string;
  warehouseId?: string;
  offsetAccountId: string; // e.g. Partner Capital / Opening Balance Equity
  moveDate: string;
  lines: OpeningStockLine[];
  userId?: string | null;
}): Promise<{ entryId: string; totalValueMinor: bigint }> {
  return withOrg(input.orgId, async (tx) => {
    const warehouseId = input.warehouseId ?? (await getDefaultWarehouseId(tx, input.orgId));
    const inventoryAcct = await resolveControlAccount(tx, input.orgId, "inventory");

    const valued = input.lines.map((l) => {
      const qtyScaled = toScaledQty(l.quantity);
      if (qtyScaled <= 0n) {
        throw new LedgerError(
          `Opening stock quantity must be positive for item ${l.itemId}.`,
          "INVALID_QUANTITY",
        );
      }
      const valueMinor = mulDivRound(l.unitCostMinor, qtyScaled, QTY_SCALE);
      return { ...l, valueMinor };
    });

    const total = valued.reduce((a, l) => a + l.valueMinor, 0n);
    if (total <= 0n) {
      throw new LedgerError("Opening stock has no value.", "INVALID_QUANTITY");
    }

    const entry = await postJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.moveDate,
        source: "opening_balance",
        memo: "Opening stock",
        userId: input.userId,
        lines: [
          debit(inventoryAcct, total, { memo: "Opening inventory" }),
          credit(input.offsetAccountId, total, { memo: "Opening stock contributed" }),
        ],
      },
      tx,
    );

    for (const l of valued) {
      await receiveStock(tx, {
        orgId: input.orgId,
        itemId: l.itemId,
        warehouseId,
        moveDate: input.moveDate,
        quantity: l.quantity,
        valueMinor: l.valueMinor,
        source: "opening_balance",
        jeId: entry.entryId,
        userId: input.userId,
      });
    }

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "inventory.opening_stock",
      entityType: "journal_entry",
      entityId: entry.entryId,
      after: { items: valued.length, totalValueMinor: total.toString() },
    });

    return { entryId: entry.entryId, totalValueMinor: total };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reads — for reports and integrity checks
 * ──────────────────────────────────────────────────────────────────────────*/

export type StockSummaryRow = {
  itemId: string;
  sku: string | null;
  name: string;
  onHandQty: string;
  valueMinor: bigint;
  avgCostMinor: bigint;
};

/** On-hand and value per item across all warehouses, from the cached levels. */
export async function getStockSummary(tx: DbOrTx, orgId: string): Promise<StockSummaryRow[]> {
  const rows = (await tx.execute(sql`
    select i.id as item_id, i.sku, i.name,
           coalesce(sum(l.on_hand_qty), 0)  as on_hand_qty,
           coalesce(sum(l.value_minor), 0)  as value_minor
    from items i
    left join item_stock_levels l on l.item_id = i.id
    where i.org_id = ${orgId} and i.is_inventory_tracked = true
    group by i.id, i.sku, i.name
    order by i.name
  `)) as unknown as Array<{
    item_id: string;
    sku: string | null;
    name: string;
    on_hand_qty: string;
    value_minor: string;
  }>;

  return rows.map((r) => {
    const qtyScaled = toScaledQty(r.on_hand_qty);
    const valueMinor = BigInt(r.value_minor);
    return {
      itemId: r.item_id,
      sku: r.sku,
      name: r.name,
      onHandQty: r.on_hand_qty,
      valueMinor,
      avgCostMinor: qtyScaled > 0n ? mulDivRound(valueMinor, QTY_SCALE, qtyScaled) : 0n,
    };
  });
}

/**
 * The item's current weighted-average unit cost at a warehouse, in paise. Used to
 * value returned goods on a credit note. Falls back to the item's standard
 * purchase price when no stock is on hand (so a fully-depleted item still values).
 */
export async function getCurrentAvgCost(
  tx: DbOrTx,
  orgId: string,
  itemId: string,
  warehouseId: string,
): Promise<bigint> {
  const rows = (await tx.execute(sql`
    select on_hand_qty, value_minor
    from item_stock_levels
    where org_id = ${orgId} and item_id = ${itemId} and warehouse_id = ${warehouseId}
  `)) as unknown as Array<{ on_hand_qty: string; value_minor: string }>;

  if (rows[0]) {
    const qtyScaled = toScaledQty(rows[0].on_hand_qty);
    const value = BigInt(rows[0].value_minor);
    if (qtyScaled > 0n) return mulDivRound(value, QTY_SCALE, qtyScaled);
  }

  const [item] = await tx
    .select({ purchasePriceMinor: items.purchasePriceMinor })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.orgId, orgId)))
    .limit(1);
  return item?.purchasePriceMinor ?? 0n;
}

/**
 * For FIFO items, Σ remaining layer value must equal Σ cached level value — the
 * layers and the running balance are two views of the same stock and can't drift.
 */
export async function getFifoReconciliation(
  tx: DbOrTx,
  orgId: string,
): Promise<{ layerValueMinor: bigint; levelValueMinor: bigint }> {
  const rows = (await tx.execute(sql`
    with fifo_items as (select id from items where org_id = ${orgId} and valuation_method = 'fifo')
    select
      coalesce((select sum(remaining_value_minor) from stock_layers where org_id = ${orgId} and item_id in (select id from fifo_items)), 0) as layer_value,
      coalesce((select sum(value_minor) from item_stock_levels where org_id = ${orgId} and item_id in (select id from fifo_items)), 0) as level_value
  `)) as unknown as Array<{ layer_value: string; level_value: string }>;
  return {
    layerValueMinor: BigInt(rows[0].layer_value),
    levelValueMinor: BigInt(rows[0].level_value),
  };
}

/** Total value of all stock on hand — must equal the Inventory account balance. */
export async function getStockValuationTotal(tx: DbOrTx, orgId: string): Promise<bigint> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(value_minor), 0) as total
    from item_stock_levels where org_id = ${orgId}
  `)) as unknown as Array<{ total: string }>;
  return BigInt(rows[0].total);
}

/** Convenience: is a line's item stock-tracked? Callers hook on this. */
export async function getTrackedItem(
  tx: DbOrTx,
  orgId: string,
  itemId: string,
): Promise<{ id: string; inventoryAccountId: string | null; cogsAccountId: string | null } | null> {
  const [item] = await tx
    .select({
      id: items.id,
      isInventoryTracked: items.isInventoryTracked,
      inventoryAccountId: items.inventoryAccountId,
      cogsAccountId: items.cogsAccountId,
    })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.orgId, orgId)))
    .limit(1);
  if (!item || !item.isInventoryTracked) return null;
  return {
    id: item.id,
    inventoryAccountId: item.inventoryAccountId,
    cogsAccountId: item.cogsAccountId,
  };
}

/**
 * Read-only pre-flight: throw INSUFFICIENT_STOCK if issuing these quantities from
 * `warehouseId` would drive any item negative. Requirements are aggregated per
 * item first (the same item can appear on several lines). This is a *pre-flight*,
 * not the authoritative guard — `postMovement` still enforces availability under a
 * row lock at post time — so a POS checkout can fail fast, before it creates a
 * half-finished invoice, when the shelf is simply empty. Total on-hand is the
 * right test for both weighted-average and FIFO (which only picks the layers).
 */
export async function assertStockAvailable(
  tx: DbOrTx,
  orgId: string,
  warehouseId: string,
  requirements: Array<{ itemId: string; qtyScaled: bigint }>,
): Promise<void> {
  const needed = new Map<string, bigint>();
  for (const r of requirements) {
    needed.set(r.itemId, (needed.get(r.itemId) ?? 0n) + r.qtyScaled);
  }
  for (const [itemId, need] of needed) {
    if (need <= 0n) continue;
    const rows = (await tx.execute(sql`
      select on_hand_qty from item_stock_levels
      where org_id = ${orgId} and item_id = ${itemId} and warehouse_id = ${warehouseId}
    `)) as unknown as Array<{ on_hand_qty: string }>;
    const available = rows[0] ? toScaledQty(rows[0].on_hand_qty) : 0n;
    if (available < need) {
      const [it] = await tx
        .select({ name: items.name })
        .from(items)
        .where(and(eq(items.id, itemId), eq(items.orgId, orgId)));
      throw new LedgerError(
        `Insufficient stock for ${it?.name ?? itemId}: ${fromScaledQty(available)} on hand, ` +
          `${fromScaledQty(need)} needed.`,
        "INSUFFICIENT_STOCK",
      );
    }
  }
}
