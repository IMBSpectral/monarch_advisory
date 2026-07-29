/**
 * Maker-checker for single-step postings (payments, manual journals).
 *
 * Bills and invoices have a draft→post lifecycle, so their approval gate is just
 * "a different person posts the draft" (see approvals.ts). Payments and manual
 * journals post in one step, so there's no draft to hold — instead, when the
 * amount is at or above the org threshold, we store the *intent* here and execute
 * it only when a different user approves. The approval replays the exact same
 * operation with the approver's identity, so separation of duties holds and the
 * posting code runs unchanged. Nothing hits the ledger until approval.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import { pendingApprovals, users } from "@/db/schema";
import { LedgerError, credit, debit, postJournalEntry } from "./ledger";
import { recordVendorPayment } from "./bills";
import { recordCustomerPayment } from "./invoicing";
import { approvalThreshold } from "./approvals";

export type ApprovalOperation = "payment.customer" | "payment.vendor" | "journal.manual";

/** The capability a user needs to originate — and therefore to approve — each op. */
export const APPROVAL_CAPABILITY: Record<ApprovalOperation, string> = {
  "payment.customer": "payment:record",
  "payment.vendor": "payment:record",
  "journal.manual": "ledger:post",
};

/* ── Executors: the single place each operation actually runs. Used by both the
 * immediate (below-threshold) path and the approval path, so there's no drift. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

async function execCustomerPayment(orgId: string, p: Payload, userId: string): Promise<string> {
  const r = await recordCustomerPayment({
    orgId,
    contactId: p.contactId,
    paymentDate: p.paymentDate,
    amountMinor: BigInt(p.amountMinor),
    depositAccountId: p.depositAccountId,
    method: p.method,
    referenceNumber: p.referenceNumber,
    userId,
    allocations: (p.allocations ?? []).map((a: Payload) => ({
      invoiceId: a.invoiceId,
      amountMinor: BigInt(a.amountMinor),
    })),
  });
  return r.paymentNumber;
}

async function execVendorPayment(orgId: string, p: Payload, userId: string): Promise<string> {
  const r = await recordVendorPayment({
    orgId,
    contactId: p.contactId,
    paymentDate: p.paymentDate,
    amountMinor: BigInt(p.amountMinor),
    depositAccountId: p.paymentAccountId,
    method: p.method,
    referenceNumber: p.referenceNumber,
    userId,
    allocations: (p.allocations ?? []).map((a: Payload) => ({
      billId: a.billId,
      amountMinor: BigInt(a.amountMinor),
    })),
  });
  return r.paymentNumber;
}

async function execManualJournal(orgId: string, p: Payload, userId: string): Promise<string> {
  const lines = (p.lines as Payload[]).map((l) => {
    const rest = { costCenterId: l.costCenterId ?? null, memo: l.memo };
    return l.side === "debit"
      ? debit(l.accountId, BigInt(l.amountMinor), rest)
      : credit(l.accountId, BigInt(l.amountMinor), rest);
  });
  const r = await postJournalEntry({
    orgId,
    entryDate: p.entryDate,
    source: "manual",
    reference: p.reference ?? null,
    memo: p.memo ?? null,
    userId,
    lines,
  });
  return r.entryNumber;
}

const EXECUTORS: Record<ApprovalOperation, (o: string, p: Payload, u: string) => Promise<string>> =
  {
    "payment.customer": execCustomerPayment,
    "payment.vendor": execVendorPayment,
    "journal.manual": execManualJournal,
  };

/**
 * Run an operation now, or queue it for approval if it's at/above the org
 * threshold. `amountMinor` is the document value the threshold is compared to.
 */
export async function executeOrQueue(args: {
  orgId: string;
  operation: ApprovalOperation;
  payload: Payload;
  amountMinor: bigint;
  summary: string;
  userId: string;
}): Promise<{ pending: boolean; ref?: string; pendingId?: string }> {
  const threshold = await withOrg(args.orgId, (tx) => approvalThreshold(tx, args.orgId));
  if (threshold !== null && args.amountMinor >= threshold) {
    const [row] = await withOrg(args.orgId, (tx) =>
      tx
        .insert(pendingApprovals)
        .values({
          orgId: args.orgId,
          operation: args.operation,
          payloadJson: args.payload,
          amountMinor: args.amountMinor,
          summary: args.summary,
          requestedByUserId: args.userId,
          status: "pending",
        })
        .returning({ id: pendingApprovals.id }),
    );
    return { pending: true, pendingId: row.id };
  }
  const ref = await EXECUTORS[args.operation](args.orgId, args.payload, args.userId);
  return { pending: false, ref };
}

/** Pending items waiting for a checker, newest first, with the requester's name. */
export async function listPendingApprovals(orgId: string) {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: pendingApprovals.id,
        operation: pendingApprovals.operation,
        amountMinor: pendingApprovals.amountMinor,
        summary: pendingApprovals.summary,
        requestedByUserId: pendingApprovals.requestedByUserId,
        requestedByName: users.name,
        createdAt: pendingApprovals.createdAt,
      })
      .from(pendingApprovals)
      .leftJoin(users, eq(users.id, pendingApprovals.requestedByUserId))
      .where(and(eq(pendingApprovals.orgId, orgId), eq(pendingApprovals.status, "pending")))
      .orderBy(desc(pendingApprovals.createdAt));
    return rows.map((r) => ({
      id: r.id,
      operation: r.operation,
      amountMinor: r.amountMinor.toString(),
      summary: r.summary,
      requestedByUserId: r.requestedByUserId,
      requestedByName: r.requestedByName,
      createdAt: r.createdAt,
    }));
  });
}

/** The operation of a pending item — so the API layer can assert the right capability. */
export async function pendingOperation(
  orgId: string,
  pendingId: string,
): Promise<ApprovalOperation | null> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ operation: pendingApprovals.operation })
      .from(pendingApprovals)
      .where(and(eq(pendingApprovals.id, pendingId), eq(pendingApprovals.orgId, orgId))),
  );
  return (row?.operation as ApprovalOperation | undefined) ?? null;
}

/**
 * Approve a pending item: atomically claim it (only if still pending AND the
 * approver is not the requester), execute the operation as the approver, then
 * record the result. If execution fails, the claim is released so it stays in the
 * queue. Enforces separation of duties via the claim's WHERE clause.
 */
export async function approvePending(args: {
  orgId: string;
  pendingId: string;
  approverId: string;
}): Promise<{ ref: string }> {
  const { orgId, pendingId, approverId } = args;

  // Atomic claim: pending AND not self-approval. A returned row means we own it.
  const [claimed] = await withOrg(orgId, (tx) =>
    tx
      .update(pendingApprovals)
      .set({ status: "approved", decidedByUserId: approverId, decidedAt: new Date() })
      .where(
        and(
          eq(pendingApprovals.id, pendingId),
          eq(pendingApprovals.orgId, orgId),
          eq(pendingApprovals.status, "pending"),
          sql`${pendingApprovals.requestedByUserId} is distinct from ${approverId}`,
        ),
      )
      .returning({
        operation: pendingApprovals.operation,
        payloadJson: pendingApprovals.payloadJson,
      }),
  );

  if (!claimed) {
    // Disambiguate: self-approval vs already-decided/not-found.
    const [row] = await withOrg(orgId, (tx) =>
      tx
        .select({
          status: pendingApprovals.status,
          requestedByUserId: pendingApprovals.requestedByUserId,
        })
        .from(pendingApprovals)
        .where(and(eq(pendingApprovals.id, pendingId), eq(pendingApprovals.orgId, orgId))),
    );
    if (row && row.status === "pending" && row.requestedByUserId === approverId) {
      throw new LedgerError(
        "You can't approve a request you submitted yourself — a different user must approve it.",
        "APPROVAL_SEPARATION_REQUIRED",
      );
    }
    throw new LedgerError(
      "This request is no longer pending (it may already be approved or rejected).",
      "APPROVAL_NOT_PENDING",
    );
  }

  try {
    const ref = await EXECUTORS[claimed.operation as ApprovalOperation](
      orgId,
      claimed.payloadJson as Payload,
      approverId,
    );
    await withOrg(orgId, (tx) =>
      tx
        .update(pendingApprovals)
        .set({ resultRef: ref, updatedAt: new Date() })
        .where(and(eq(pendingApprovals.id, pendingId), eq(pendingApprovals.orgId, orgId))),
    );
    return { ref };
  } catch (err) {
    // Execution failed — release the claim so it stays actionable in the queue.
    await withOrg(orgId, (tx) =>
      tx
        .update(pendingApprovals)
        .set({ status: "pending", decidedByUserId: null, decidedAt: null })
        .where(and(eq(pendingApprovals.id, pendingId), eq(pendingApprovals.orgId, orgId))),
    ).catch(() => {});
    throw err;
  }
}

/** Reject (or withdraw) a pending item. No ledger effect. */
export async function rejectPending(args: {
  orgId: string;
  pendingId: string;
  userId: string;
  reason: string;
}): Promise<{ ok: true }> {
  const [row] = await withOrg(args.orgId, (tx) =>
    tx
      .update(pendingApprovals)
      .set({
        status: "rejected",
        decidedByUserId: args.userId,
        decidedAt: new Date(),
        reason: args.reason,
      })
      .where(
        and(
          eq(pendingApprovals.id, args.pendingId),
          eq(pendingApprovals.orgId, args.orgId),
          eq(pendingApprovals.status, "pending"),
        ),
      )
      .returning({ id: pendingApprovals.id }),
  );
  if (!row) {
    throw new LedgerError("This request is no longer pending.", "APPROVAL_NOT_PENDING");
  }
  return { ok: true };
}
