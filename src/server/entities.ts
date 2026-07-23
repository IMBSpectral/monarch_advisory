/**
 * Master-data services — contacts, items, tax rates, bank accounts.
 *
 * These are the nouns the ledger refers to but doesn't itself post: a customer,
 * a product, a GST rate, a bank feed line. They have no journal impact on their
 * own, so unlike invoices and bills they don't go through the posting engine —
 * but they are still org-scoped, so every read and write goes through
 * `withOrg()` and is therefore subject to row-level security.
 *
 * WHY A SEPARATE FILE FROM invoicing/bills. Those modules turn documents into
 * ledger entries and their correctness is load-bearing for the books. This is
 * plain CRUD. Keeping them apart stops the posting engine's invariants from
 * getting diluted with form-field validation, and keeps this file approachable.
 */

import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { withOrg } from "@/db/client";
import {
  bankAccounts,
  bankTransactions,
  contacts,
  items,
  taxRates,
  type Address,
} from "@/db/schema";
import { LedgerError, writeAudit } from "./ledger";

/* ────────────────────────────────────────────────────────────────────────────
 * Contacts (customers & vendors)
 * ──────────────────────────────────────────────────────────────────────────*/

export type ContactType = "customer" | "vendor" | "both";

export type ContactInput = {
  displayName: string;
  type: ContactType;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  taxRegistrationNumber?: string | null;
  placeOfSupplyCode?: string | null;
  paymentTermDays?: number;
  creditLimitMinor?: bigint | null;
  billingAddress?: Address | null;
  notes?: string | null;
};

/**
 * List contacts, optionally filtered by kind and a search string.
 *
 * `type: "customer"` also returns `both` contacts, because a party you both buy
 * from and sell to is a customer when you're looking at the customer list. The
 * caller asked "who can I invoice", and the answer includes them.
 */
export async function listContacts(
  orgId: string,
  opts: { type?: "customer" | "vendor"; search?: string; includeInactive?: boolean } = {},
) {
  return withOrg(orgId, (tx) => {
    const filters = [eq(contacts.orgId, orgId), isNull(contacts.deletedAt)];

    if (opts.type === "customer") {
      filters.push(or(eq(contacts.type, "customer"), eq(contacts.type, "both"))!);
    } else if (opts.type === "vendor") {
      filters.push(or(eq(contacts.type, "vendor"), eq(contacts.type, "both"))!);
    }
    if (!opts.includeInactive) {
      filters.push(eq(contacts.isActive, true));
    }
    if (opts.search?.trim()) {
      filters.push(ilike(contacts.displayName, `%${opts.search.trim()}%`)!);
    }

    return tx
      .select()
      .from(contacts)
      .where(and(...filters))
      .orderBy(asc(contacts.displayName));
  });
}

export async function getContact(orgId: string, contactId: string) {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)));
    return row ?? null;
  });
}

export async function createContact(
  orgId: string,
  input: ContactInput,
  userId?: string | null,
): Promise<{ id: string }> {
  const name = input.displayName.trim();
  if (!name) throw new LedgerError("A contact needs a name.", "CONTACT_NAME_REQUIRED");

  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .insert(contacts)
      .values({
        orgId,
        type: input.type,
        displayName: name,
        legalName: input.legalName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        taxRegistrationNumber: input.taxRegistrationNumber ?? null,
        placeOfSupplyCode: input.placeOfSupplyCode ?? null,
        paymentTermDays: input.paymentTermDays ?? 30,
        creditLimitMinor: input.creditLimitMinor ?? null,
        billingAddress: input.billingAddress ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: contacts.id });

    await writeAudit(tx, {
      orgId,
      userId: userId ?? null,
      action: "contact.created",
      entityType: "contact",
      entityId: row.id,
      after: { displayName: name, type: input.type },
    });

    return { id: row.id };
  });
}

export async function updateContact(
  orgId: string,
  contactId: string,
  input: Partial<ContactInput> & { isActive?: boolean },
  userId?: string | null,
): Promise<void> {
  return withOrg(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)));
    if (!existing) throw new LedgerError("Contact not found.", "CONTACT_NOT_FOUND");

    await tx
      .update(contacts)
      .set({
        displayName: input.displayName?.trim() ?? existing.displayName,
        type: input.type ?? existing.type,
        legalName: input.legalName ?? existing.legalName,
        email: input.email ?? existing.email,
        phone: input.phone ?? existing.phone,
        taxRegistrationNumber: input.taxRegistrationNumber ?? existing.taxRegistrationNumber,
        placeOfSupplyCode: input.placeOfSupplyCode ?? existing.placeOfSupplyCode,
        paymentTermDays: input.paymentTermDays ?? existing.paymentTermDays,
        creditLimitMinor: input.creditLimitMinor ?? existing.creditLimitMinor,
        billingAddress: input.billingAddress ?? existing.billingAddress,
        notes: input.notes ?? existing.notes,
        isActive: input.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, contactId));

    await writeAudit(tx, {
      orgId,
      userId: userId ?? null,
      action: "contact.updated",
      entityType: "contact",
      entityId: contactId,
      before: { displayName: existing.displayName, isActive: existing.isActive },
      after: { displayName: input.displayName ?? existing.displayName },
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Items (products & services)
 * ──────────────────────────────────────────────────────────────────────────*/

export type ItemInput = {
  name: string;
  sku?: string | null;
  description?: string | null;
  isInventoryTracked?: boolean;
  unitOfMeasure?: string;
  salePriceMinor?: bigint | null;
  purchasePriceMinor?: bigint | null;
  hsnSacCode?: string | null;
  defaultTaxRateId?: string | null;
};

export async function listItems(
  orgId: string,
  opts: { search?: string; includeInactive?: boolean } = {},
) {
  return withOrg(orgId, (tx) => {
    const filters = [eq(items.orgId, orgId), isNull(items.deletedAt)];
    if (!opts.includeInactive) filters.push(eq(items.isActive, true));
    if (opts.search?.trim()) {
      filters.push(
        or(
          ilike(items.name, `%${opts.search.trim()}%`),
          ilike(items.sku, `%${opts.search.trim()}%`),
        )!,
      );
    }
    return tx
      .select()
      .from(items)
      .where(and(...filters))
      .orderBy(asc(items.name));
  });
}

export async function createItem(
  orgId: string,
  input: ItemInput,
  userId?: string | null,
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name) throw new LedgerError("An item needs a name.", "ITEM_NAME_REQUIRED");

  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .insert(items)
      .values({
        orgId,
        name,
        sku: input.sku?.trim() || null,
        description: input.description ?? null,
        isInventoryTracked: input.isInventoryTracked ?? false,
        unitOfMeasure: input.unitOfMeasure ?? "PCS",
        salePriceMinor: input.salePriceMinor ?? null,
        purchasePriceMinor: input.purchasePriceMinor ?? null,
        hsnSacCode: input.hsnSacCode ?? null,
        defaultTaxRateId: input.defaultTaxRateId ?? null,
      })
      .returning({ id: items.id });

    await writeAudit(tx, {
      orgId,
      userId: userId ?? null,
      action: "item.created",
      entityType: "item",
      entityId: row.id,
      after: { name, sku: input.sku ?? null },
    });

    return { id: row.id };
  });
}

export async function updateItem(
  orgId: string,
  itemId: string,
  input: Partial<ItemInput> & { isActive?: boolean },
  userId?: string | null,
): Promise<void> {
  return withOrg(orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.orgId, orgId)));
    if (!existing) throw new LedgerError("Item not found.", "ITEM_NOT_FOUND");

    await tx
      .update(items)
      .set({
        name: input.name?.trim() ?? existing.name,
        sku: input.sku !== undefined ? input.sku : existing.sku,
        description: input.description ?? existing.description,
        isInventoryTracked: input.isInventoryTracked ?? existing.isInventoryTracked,
        unitOfMeasure: input.unitOfMeasure ?? existing.unitOfMeasure,
        salePriceMinor: input.salePriceMinor ?? existing.salePriceMinor,
        purchasePriceMinor: input.purchasePriceMinor ?? existing.purchasePriceMinor,
        hsnSacCode: input.hsnSacCode ?? existing.hsnSacCode,
        defaultTaxRateId: input.defaultTaxRateId ?? existing.defaultTaxRateId,
        isActive: input.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId));

    await writeAudit(tx, {
      orgId,
      userId: userId ?? null,
      action: "item.updated",
      entityType: "item",
      entityId: itemId,
      before: { name: existing.name },
      after: { name: input.name ?? existing.name },
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tax rates
 * ──────────────────────────────────────────────────────────────────────────*/

export async function listTaxRates(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.orgId, orgId), eq(taxRates.isActive, true)))
      .orderBy(asc(taxRates.rateBps)),
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Bank accounts & feed
 * ──────────────────────────────────────────────────────────────────────────*/

export async function listBankAccounts(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.orgId, orgId), isNull(bankAccounts.deletedAt)))
      .orderBy(asc(bankAccounts.name)),
  );
}

/**
 * Feed transactions for one account (or all), newest first.
 *
 * `status` filters to a workflow stage — the reconciliation screen wants only
 * `unreconciled`, the review screen wants everything.
 */
export async function listBankTransactions(
  orgId: string,
  opts: { bankAccountId?: string; status?: string; limit?: number } = {},
) {
  return withOrg(orgId, (tx) => {
    const filters = [eq(bankTransactions.orgId, orgId)];
    if (opts.bankAccountId) {
      filters.push(eq(bankTransactions.bankAccountId, opts.bankAccountId));
    }
    if (opts.status) {
      filters.push(
        eq(
          bankTransactions.status,
          opts.status as (typeof bankTransactions.status.enumValues)[number],
        ),
      );
    }
    return tx
      .select()
      .from(bankTransactions)
      .where(and(...filters))
      .orderBy(desc(bankTransactions.transactionDate))
      .limit(opts.limit ?? 100);
  });
}

/**
 * A rough "how healthy is this feed" summary for the banking dashboard: the GL
 * cash balance per bank account and how it compares to the bank's own reported
 * balance. A gap is not necessarily an error — it's unreconciled activity — but
 * it's the number a bookkeeper looks at first.
 */
export async function getBankSummary(orgId: string) {
  return withOrg(orgId, async (tx) => {
    const rows = await tx.execute(sql`
      select ba.id,
             ba.name,
             ba.institution_name,
             ba.account_number_masked,
             ba.feed_balance_minor,
             ba.feed_last_synced_at,
             coalesce(sum(jl.amount_minor), 0) as gl_balance_minor,
             count(bt.id) filter (where bt.status = 'unreconciled') as unreconciled_count
      from bank_accounts ba
      left join journal_lines jl
             on jl.account_id = ba.account_id and jl.org_id = ba.org_id
      left join bank_transactions bt
             on bt.bank_account_id = ba.id
      where ba.org_id = ${orgId}
        and ba.deleted_at is null
      group by ba.id
      order by ba.name
    `);
    return rows as unknown as Array<{
      id: string;
      name: string;
      institution_name: string | null;
      account_number_masked: string | null;
      feed_balance_minor: string | null;
      feed_last_synced_at: string | null;
      gl_balance_minor: string;
      unreconciled_count: string;
    }>;
  });
}
