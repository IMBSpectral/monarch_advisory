/**
 * Bank-statement import. Parsed statement rows become `bank_transactions`,
 * deduplicated on a stable external id so re-importing the same file can't
 * double-count. From there they flow into the existing reconciliation screens.
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { bankAccounts, bankTransactions } from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";
import { withIdempotency } from "@/server/idempotency";
import {
  categorizeTransaction,
  excludeTransaction,
  getReconciliationData,
  matchTransactionToPayment,
  unreconcileTransaction,
} from "@/server/reconciliation";

export const fetchImportableBankAccounts = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, (tx) =>
    tx
      .select({ id: bankAccounts.id, name: bankAccounts.name, currency: bankAccounts.currency })
      .from(bankAccounts)
      .where(eq(bankAccounts.orgId, orgId))
      .orderBy(bankAccounts.name),
  );
});

export const importBankStatementFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      bankAccountId: z.string().uuid(),
      rows: z
        .array(
          z.object({
            transactionDate: z.string(),
            description: z.string().min(1),
            amountMinor: z.string(), // signed: + in, − out
          }),
        )
        .min(1)
        .max(2000),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("bank:reconcile");
    return withOrg(p.orgId, async (tx) => {
      const [acct] = await tx
        .select({ currency: bankAccounts.currency })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, data.bankAccountId), eq(bankAccounts.orgId, p.orgId)));
      if (!acct) throw new Error("Bank account not found.");

      // A statement can legitimately contain two identical rows (e.g. two ₹100
      // ATM withdrawals same day). Suffix repeats with an occurrence index so they
      // don't collide on the unique (account, external_id) index, while a re-import
      // of the same file still dedups (identical rows → identical suffixes).
      const seen = new Map<string, number>();
      const values = data.rows
        .filter((r) => BigInt(r.amountMinor) !== 0n)
        .map((r) => {
          const key = `${r.transactionDate}|${r.amountMinor}|${r.description.trim()}`;
          const n = seen.get(key) ?? 0;
          seen.set(key, n + 1);
          return {
            orgId: p.orgId,
            bankAccountId: data.bankAccountId,
            transactionDate: r.transactionDate,
            description: r.description.trim(),
            amountMinor: BigInt(r.amountMinor),
            currency: acct.currency ?? "INR",
            externalId: n === 0 ? key : `${key}#${n}`,
          };
        });

      // Count how many are genuinely new (dedup on the unique external id).
      const count = async () =>
        Number(
          (
            (await tx.execute(
              sql`select count(*)::int as n from bank_transactions where bank_account_id = ${data.bankAccountId}`,
            )) as unknown as Array<{ n: number }>
          )[0].n,
        );

      const before = await count();
      await tx.insert(bankTransactions).values(values).onConflictDoNothing();
      const imported = (await count()) - before;

      return { imported, skipped: values.length - imported };
    });
  });

export const fetchBankTransactionsFor = createServerFn({ method: "GET" })
  .validator(z.object({ bankAccountId: z.string().uuid() }).optional())
  .handler(async ({ data }) => {
    const { orgId } = await requireAuth();
    return withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({
          id: bankTransactions.id,
          date: bankTransactions.transactionDate,
          description: bankTransactions.description,
          amountMinor: bankTransactions.amountMinor,
          status: bankTransactions.status,
        })
        .from(bankTransactions)
        .where(
          data?.bankAccountId
            ? and(
                eq(bankTransactions.orgId, orgId),
                eq(bankTransactions.bankAccountId, data.bankAccountId),
              )
            : eq(bankTransactions.orgId, orgId),
        )
        .orderBy(desc(bankTransactions.transactionDate))
        .limit(100);
      return rows.map((r) => ({ ...r, amount: r.amountMinor.toString(), amountMinor: undefined }));
    });
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Reconciliation — persisting a bank-feed line as a settled fact.
 * ──────────────────────────────────────────────────────────────────────────*/

/** Everything the reconciliation workspace needs for one bank account. */
export const fetchReconciliation = createServerFn({ method: "GET" })
  .validator(z.object({ bankAccountId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { orgId } = await requireAuth();
    return getReconciliationData(orgId, data.bankAccountId);
  });

/** Match a feed line to a payment already recorded (links, posts nothing new). */
export const reconcileMatchFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      bankTransactionId: z.string().uuid(),
      paymentId: z.string().uuid(),
      idempotencyKey: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("bank:reconcile");
    return withIdempotency(p.orgId, data.idempotencyKey, "bank.match", () =>
      matchTransactionToPayment({
        orgId: p.orgId,
        bankTransactionId: data.bankTransactionId,
        paymentId: data.paymentId,
        userId: p.userId,
      }),
    );
  });

/** Categorize a bank-only feed line (interest, charges) — posts a journal entry. */
export const reconcileCategorizeFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      bankTransactionId: z.string().uuid(),
      categoryAccountId: z.string().uuid(),
      memo: z.string().max(500).optional(),
      idempotencyKey: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("bank:reconcile");
    return withIdempotency(p.orgId, data.idempotencyKey, "bank.categorize", () =>
      categorizeTransaction({
        orgId: p.orgId,
        bankTransactionId: data.bankTransactionId,
        categoryAccountId: data.categoryAccountId,
        memo: data.memo ?? null,
        userId: p.userId,
      }),
    );
  });

/** Exclude a feed line from reconciliation (e.g. a duplicate internal transfer). */
export const reconcileExcludeFn = createServerFn({ method: "POST" })
  .validator(z.object({ bankTransactionId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const p = await requirePermission("bank:reconcile");
    return excludeTransaction({
      orgId: p.orgId,
      bankTransactionId: data.bankTransactionId,
      userId: p.userId,
    });
  });

/** Undo a reconciliation — reverses a categorization's entry or unlinks a match. */
export const unreconcileFn = createServerFn({ method: "POST" })
  .validator(z.object({ bankTransactionId: z.string().uuid(), reason: z.string().min(1).max(500) }))
  .handler(async ({ data }) => {
    const p = await requirePermission("bank:reconcile");
    return unreconcileTransaction({
      orgId: p.orgId,
      bankTransactionId: data.bankTransactionId,
      reason: data.reason,
      userId: p.userId,
    });
  });
