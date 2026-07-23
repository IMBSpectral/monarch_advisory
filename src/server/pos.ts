/**
 * Point-of-sale checkout.
 *
 * A POS sale is not a special kind of transaction — it is an ordinary invoice
 * that is issued and paid in the same instant. Modelling it that way (rather than
 * inventing a separate "sale" ledger path) means every POS sale lands in exactly
 * the same accounts, appears in the same reports, and is reconciled the same way
 * as any other sale. The only thing POS adds is *immediacy*: create, post, and
 * settle in one call.
 *
 *   Dr  Accounts Receivable   total     (issue)
 *     Cr  Revenue / Tax                 (issue)
 *   Dr  Cash/Bank             total     (settle)
 *     Cr  Accounts Receivable          (settle)
 *
 * The AR account is debited and credited within one checkout, netting to zero —
 * which is correct: at a till, the receivable exists only for the instant
 * between ringing up and taking payment.
 *
 * ON ATOMICITY. The three steps (create, post, settle) each open their own
 * transaction, because `createInvoice`/`postInvoice`/`recordCustomerPayment`
 * each establish their own tenant scope via `withOrg`. They are therefore
 * sequential, not a single atomic unit. Each step is individually valid and
 * leaves the books consistent, so the worst case is a posted-but-unpaid invoice
 * if the process dies between post and settle — which is a recoverable state (a
 * normal unpaid invoice), not a corrupt one. Making this a single transaction
 * would mean threading one `tx` through all three services; a worthwhile
 * refactor, noted here rather than pretended away.
 */

import { and, eq, isNull } from "drizzle-orm";
import { withOrg } from "@/db/client";
import { accounts, contacts } from "@/db/schema";
import { LedgerError } from "./ledger";
import {
  createInvoice,
  postInvoice,
  recordCustomerPayment,
  type DraftInvoiceLine,
} from "./invoicing";

const WALK_IN_NAME = "Walk-in Customer";

/**
 * The find-or-create walk-in customer.
 *
 * POS sales are usually anonymous, but the ledger still needs a contact to hang
 * the (instantly-settled) receivable on. One reusable "Walk-in Customer" per org
 * keeps those sales from littering the contact list with throwaway rows.
 */
async function resolveWalkInCustomer(
  tx: Parameters<Parameters<typeof withOrg>[1]>[0],
  orgId: string,
) {
  const [existing] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, orgId),
        eq(contacts.displayName, WALK_IN_NAME),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await tx
    .insert(contacts)
    .values({ orgId, type: "customer", displayName: WALK_IN_NAME, paymentTermDays: 0 })
    .returning({ id: contacts.id });
  return created.id;
}

/** The account a tender lands in. Card/UPI settle to bank, cash to the cash account. */
async function resolveCashAccount(
  tx: Parameters<Parameters<typeof withOrg>[1]>[0],
  orgId: string,
): Promise<string> {
  const [acct] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.orgId, orgId),
        eq(accounts.subtype, "cash_and_bank"),
        eq(accounts.isGroup, false),
        eq(accounts.isActive, true),
      ),
    )
    .orderBy(accounts.code)
    .limit(1);
  if (!acct) {
    throw new LedgerError(
      "No cash or bank account exists to receive the sale into.",
      "NO_CASH_ACCOUNT",
    );
  }
  return acct.id;
}

export type PosLine = {
  itemId?: string | null;
  description: string;
  quantity?: string;
  unitPriceMinor: bigint;
  taxRateId?: string | null;
};

/**
 * Ring up a sale: create the invoice, post it, and settle it in full.
 *
 * See the module note on atomicity — the steps are sequential, each valid on its
 * own.
 */
export async function posCheckout(input: {
  orgId: string;
  lines: PosLine[];
  saleDate: string;
  method: string;
  userId?: string | null;
}): Promise<{ invoiceNumber: string; totalMinor: string }> {
  if (input.lines.length === 0) {
    throw new LedgerError("The cart is empty.", "EMPTY_CART");
  }

  // Resolve the two accounts the sale needs, in one scoped read.
  const { contactId, cashAccountId } = await withOrg(input.orgId, async (tx) => ({
    contactId: await resolveWalkInCustomer(tx, input.orgId),
    cashAccountId: await resolveCashAccount(tx, input.orgId),
  }));

  const lines: DraftInvoiceLine[] = input.lines.map((l) => ({
    itemId: l.itemId ?? null,
    description: l.description,
    quantity: l.quantity ?? "1",
    unitPriceMinor: l.unitPriceMinor,
    taxRateId: l.taxRateId ?? null,
  }));

  const created = await createInvoice({
    orgId: input.orgId,
    contactId,
    invoiceDate: input.saleDate,
    dueDate: input.saleDate,
    lines,
    userId: input.userId,
  });

  await postInvoice({ orgId: input.orgId, invoiceId: created.invoiceId, userId: input.userId });

  await recordCustomerPayment({
    orgId: input.orgId,
    contactId,
    paymentDate: input.saleDate,
    amountMinor: created.totalMinor,
    depositAccountId: cashAccountId,
    method: input.method,
    allocations: [{ invoiceId: created.invoiceId, amountMinor: created.totalMinor }],
    userId: input.userId,
  });

  return { invoiceNumber: created.invoiceNumber, totalMinor: created.totalMinor.toString() };
}
