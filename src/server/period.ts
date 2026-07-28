/**
 * Period close — the year-end (or period-end) roll-up.
 *
 * Closing zeroes every income and expense account into Retained Earnings, then
 * freezes the books through the close date so nothing can post into the settled
 * period. It's a reclassification within equity: the balance sheet total doesn't
 * move, the profit just shifts from "current-year earnings" into the retained
 * earnings account. Reopening reverses the roll-up and lifts the freeze.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import type { DbOrTx } from "@/db/client";
import { journalEntries, organizations } from "@/db/schema";
import {
  LedgerError,
  credit,
  debit,
  postJournalEntry,
  resolveControlAccount,
  reverseJournalEntry,
  writeAudit,
  type PostingLine,
} from "./ledger";

export async function getPeriodStatus(
  tx: DbOrTx,
  orgId: string,
): Promise<{ closedThrough: string | null }> {
  const [org] = await tx
    .select({ closedThrough: organizations.booksClosedThrough })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return { closedThrough: org?.closedThrough ?? null };
}

/**
 * Close the books through `throughDate`: post the roll-up entry and set the lock.
 * The entry is posted *before* the lock is applied, so the close itself is legal.
 */
export async function closePeriod(args: {
  orgId: string;
  throughDate: string;
  userId?: string | null;
}): Promise<{ entryId: string; entryNumber: string; netProfitMinor: bigint }> {
  return withOrg(args.orgId, async (tx) => {
    const { closedThrough } = await getPeriodStatus(tx, args.orgId);
    if (closedThrough && args.throughDate <= closedThrough) {
      throw new LedgerError(
        `Books are already closed through ${closedThrough}; choose a later date.`,
        "ALREADY_CLOSED",
      );
    }

    // Every P&L account's balance from the last close (or the beginning) up to the
    // close date. Prior closes already moved earlier profit to RE, so we only pick
    // up what has accrued since — anything after `closedThrough`.
    const rows = (await tx.execute(sql`
      select a.id as account_id, a.type::text as type, sum(jl.amount_minor) as net
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where jl.org_id = ${args.orgId} and je.status in ('posted','reversed')
        and a.type in ('income','expense')
        and je.entry_date <= ${args.throughDate}
        ${closedThrough ? sql`and je.entry_date > ${closedThrough}` : sql``}
      group by a.id, a.type
      having sum(jl.amount_minor) <> 0
    `)) as unknown as Array<{ account_id: string; type: string; net: string }>;

    if (rows.length === 0) {
      throw new LedgerError("No income or expense to close for this period.", "NOTHING_TO_CLOSE");
    }

    const retainedEarnings = await resolveControlAccount(tx, args.orgId, "retained_earnings");
    const postings: PostingLine[] = [];
    let netSigned = 0n; // Σ P&L nets (debit-positive): expenses − income
    for (const r of rows) {
      const net = BigInt(r.net);
      netSigned += net;
      // Zero the account: post the opposite of its balance.
      postings.push(
        net > 0n
          ? credit(r.account_id, net, { memo: "Close to retained earnings" })
          : debit(r.account_id, -net, { memo: "Close to retained earnings" }),
      );
    }
    // Balancing line to Retained Earnings. netSigned>0 → a loss (debit RE);
    // netSigned<0 → a profit (credit RE, increasing equity).
    postings.push(
      netSigned > 0n
        ? debit(retainedEarnings, netSigned, { memo: "Net loss for period" })
        : credit(retainedEarnings, -netSigned, { memo: "Net profit for period" }),
    );

    const entry = await postJournalEntry(
      {
        orgId: args.orgId,
        entryDate: args.throughDate,
        source: "period_close",
        memo: `Period close through ${args.throughDate}`,
        userId: args.userId,
        lines: postings,
      },
      tx,
    );

    await tx
      .update(organizations)
      .set({ booksClosedThrough: args.throughDate, updatedAt: new Date() })
      .where(eq(organizations.id, args.orgId));

    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "period.closed",
      entityType: "organization",
      entityId: args.orgId,
      after: { closedThrough: args.throughDate, netProfitMinor: (-netSigned).toString() },
    });

    return { entryId: entry.entryId, entryNumber: entry.entryNumber, netProfitMinor: -netSigned };
  });
}

/**
 * Reopen the most recently closed period: lift the freeze and reverse the roll-up
 * so the income/expense accounts carry their balances again.
 */
export async function reopenPeriod(args: {
  orgId: string;
  reason: string;
  userId?: string | null;
}): Promise<{ reversedEntryNumber: string | null }> {
  if (!args.reason?.trim()) {
    throw new LedgerError(
      "Reopening a period requires a reason (it's audited).",
      "REASON_REQUIRED",
    );
  }

  // Find the latest close entry and the current lock, then lift the lock so the
  // reversal (dated in the just-reopened period) is allowed to post.
  const closeEntry = await withOrg(args.orgId, async (tx) => {
    const { closedThrough } = await getPeriodStatus(tx, args.orgId);
    if (!closedThrough) throw new LedgerError("The books are not closed.", "NOT_CLOSED");
    // The two most recent closes: we reverse the latest and drop the lock back to
    // the one before it (not fully open), so stacked earlier closes stay frozen.
    const recent = await tx
      .select({
        id: journalEntries.id,
        number: journalEntries.entryNumber,
        date: journalEntries.entryDate,
      })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, args.orgId),
          eq(journalEntries.source, "period_close"),
          eq(journalEntries.status, "posted"),
        ),
      )
      .orderBy(desc(journalEntries.entryDate))
      .limit(2);
    const entry = recent[0] ?? null;
    const priorCloseDate = recent[1]?.date ?? null;
    await tx
      .update(organizations)
      .set({ booksClosedThrough: priorCloseDate, updatedAt: new Date() })
      .where(eq(organizations.id, args.orgId));
    await writeAudit(tx, {
      orgId: args.orgId,
      userId: args.userId ?? null,
      action: "period.reopened",
      entityType: "organization",
      entityId: args.orgId,
      before: { closedThrough },
      after: { closedThrough: priorCloseDate },
      reason: args.reason,
    });
    return entry;
  });

  if (!closeEntry) return { reversedEntryNumber: null };

  await reverseJournalEntry({
    orgId: args.orgId,
    entryId: closeEntry.id,
    reason: `Period reopened: ${args.reason}`,
    userId: args.userId,
  });
  return { reversedEntryNumber: closeEntry.number };
}
