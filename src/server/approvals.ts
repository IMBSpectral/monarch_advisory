/**
 * Maker-checker, shared across document types.
 *
 * When an org sets an approval threshold, a document whose value is at or above
 * it may not be posted by the same person who created it — a different user must
 * post it, which is the approval. This is separation of duties: the control that
 * stops one person from both raising and clearing a large amount on their own.
 *
 * The check lives here so bills, invoices (and later, journals) all enforce it
 * the same way, against the same org setting.
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { organizations } from "@/db/schema";
import { LedgerError } from "./ledger";

/** The org's approval threshold in minor units, or null when approvals are off. */
export async function approvalThreshold(tx: DbOrTx, orgId: string): Promise<bigint | null> {
  const [org] = await tx
    .select({ threshold: organizations.approvalThresholdMinor })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org?.threshold ?? null;
}

/**
 * Throw APPROVAL_SEPARATION_REQUIRED when a document at or above the threshold is
 * being posted by the person who created it (or by nobody identifiable). A no-op
 * when approvals are off or the amount is below the threshold.
 */
export async function assertApprovalSeparation(args: {
  tx: DbOrTx;
  orgId: string;
  totalMinor: bigint;
  creatorId: string | null;
  posterId: string | null | undefined;
  /** For the error message, e.g. `Invoice INV-1042`. */
  docLabel: string;
}): Promise<void> {
  const threshold = await approvalThreshold(args.tx, args.orgId);
  if (threshold === null || args.totalMinor < threshold) return;
  if (!args.posterId || args.posterId === args.creatorId) {
    throw new LedgerError(
      `${args.docLabel} needs approval: a document at or above the org's approval threshold must be posted by someone other than the person who created it.`,
      "APPROVAL_SEPARATION_REQUIRED",
    );
  }
}
