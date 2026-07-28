/**
 * Contra vouchers — moving money between the org's own accounts.
 *
 * A transfer from one bank/cash account to another. It nets to zero on the
 * balance sheet (one asset down, another up), so it's the simplest possible
 * voucher: a single balanced two-line entry, posted immediately.
 *
 *   Dr  destination account   amount
 *     Cr  source account       amount
 */

import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db/client";
import { accounts, contraVouchers } from "@/db/schema";
import {
  LedgerError,
  claimNextNumber,
  credit,
  debit,
  postJournalEntry,
  writeAudit,
} from "./ledger";

export type RecordContraInput = {
  orgId: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: bigint;
  voucherDate: string;
  memo?: string;
  userId?: string | null;
};

/**
 * Record and post a fund transfer. Validates that both accounts are cash/bank
 * leaves (you don't "transfer" into revenue) and that they differ.
 */
export async function recordContra(
  input: RecordContraInput,
): Promise<{ contraId: string; voucherNumber: string; entryId: string }> {
  if (input.amountMinor <= 0n) {
    throw new LedgerError(
      `Transfer amount must be positive, got ${input.amountMinor}.`,
      "NON_POSITIVE_AMOUNT",
    );
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new LedgerError("A contra transfer needs two different accounts.", "SAME_ACCOUNT");
  }

  return withOrg(input.orgId, async (tx) => {
    const ends = await tx
      .select({ id: accounts.id, subtype: accounts.subtype, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.orgId, input.orgId)));
    const byId = new Map(ends.map((a) => [a.id, a]));
    for (const id of [input.fromAccountId, input.toAccountId]) {
      const a = byId.get(id);
      if (!a)
        throw new LedgerError(`Account ${id} not found in this organization.`, "ACCOUNT_NOT_FOUND");
      if (a.subtype !== "cash_and_bank") {
        throw new LedgerError(
          `Contra transfers move money between cash/bank accounts; ${a.name} is not one.`,
          "NOT_CASH_ACCOUNT",
        );
      }
    }

    const voucherNumber = await claimNextNumber(tx, input.orgId, "contra");
    const entry = await postJournalEntry(
      {
        orgId: input.orgId,
        entryDate: input.voucherDate,
        source: "contra",
        reference: voucherNumber,
        memo: input.memo ?? `Contra ${voucherNumber}`,
        userId: input.userId,
        lines: [
          debit(input.toAccountId, input.amountMinor, { memo: input.memo ?? "Transfer in" }),
          credit(input.fromAccountId, input.amountMinor, { memo: input.memo ?? "Transfer out" }),
        ],
      },
      tx,
    );

    const [row] = await tx
      .insert(contraVouchers)
      .values({
        orgId: input.orgId,
        voucherNumber,
        voucherDate: input.voucherDate,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amountMinor: input.amountMinor,
        memo: input.memo ?? null,
        journalEntryId: entry.entryId,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: contraVouchers.id });

    await writeAudit(tx, {
      orgId: input.orgId,
      userId: input.userId ?? null,
      action: "contra.posted",
      entityType: "contra_voucher",
      entityId: row.id,
      after: { voucherNumber, amountMinor: input.amountMinor.toString() },
    });

    return { contraId: row.id, voucherNumber, entryId: entry.entryId };
  });
}
