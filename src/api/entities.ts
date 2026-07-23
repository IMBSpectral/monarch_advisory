/**
 * Server functions for master data — contacts, items, tax rates, banking.
 *
 * The read side of everything the UI lists. Reads require a session; writes
 * require a capability. bigint columns are stringified at this boundary, exactly
 * as in `index.ts` — the browser never does money math.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  createContact,
  createItem,
  getBankSummary,
  listBankAccounts,
  listBankTransactions,
  listContacts,
  listItems,
  listTaxRates,
  updateContact,
  updateItem,
} from "@/server/entities";
import { requireAuth, requirePermission } from "@/server/session";

/** Serialize the nullable bigint money columns a contact/item can carry. */
const money = (v: bigint | null | undefined) => (v == null ? null : v.toString());

/* ────────────────────────────────────────────────────────────────────────────
 * Contacts
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchContacts = createServerFn({ method: "GET" })
  .validator(
    z
      .object({
        type: z.enum(["customer", "vendor"]).optional(),
        search: z.string().optional(),
        includeInactive: z.boolean().optional(),
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    const { orgId } = await requireAuth();
    const rows = await listContacts(orgId, data ?? {});
    return rows.map((c) => ({
      id: c.id,
      type: c.type,
      displayName: c.displayName,
      legalName: c.legalName,
      email: c.email,
      phone: c.phone,
      taxRegistrationNumber: c.taxRegistrationNumber,
      placeOfSupplyCode: c.placeOfSupplyCode,
      paymentTermDays: c.paymentTermDays,
      creditLimit: money(c.creditLimitMinor),
      isActive: c.isActive,
      billingAddress: c.billingAddress ?? null,
      notes: c.notes,
    }));
  });

const contactInputSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  type: z.enum(["customer", "vendor", "both"]),
  legalName: z.string().max(200).optional().nullable(),
  email: z.string().email().max(320).optional().nullable().or(z.literal("")),
  phone: z.string().max(40).optional().nullable(),
  taxRegistrationNumber: z.string().max(40).optional().nullable(),
  placeOfSupplyCode: z.string().max(4).optional().nullable(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
  creditLimit: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export const createContactFn = createServerFn({ method: "POST" })
  .validator(contactInputSchema)
  .handler(async ({ data }) => {
    const principal = await requirePermission("contact:manage");
    return createContact(
      principal.orgId,
      {
        displayName: data.displayName,
        type: data.type,
        legalName: data.legalName ?? null,
        email: data.email || null,
        phone: data.phone ?? null,
        taxRegistrationNumber: data.taxRegistrationNumber ?? null,
        placeOfSupplyCode: data.placeOfSupplyCode ?? null,
        paymentTermDays: data.paymentTermDays,
        creditLimitMinor: data.creditLimit ? BigInt(data.creditLimit) : null,
        notes: data.notes ?? null,
      },
      principal.userId,
    );
  });

export const updateContactFn = createServerFn({ method: "POST" })
  .validator(
    contactInputSchema
      .partial()
      .extend({ id: z.string().uuid(), isActive: z.boolean().optional() }),
  )
  .handler(async ({ data }) => {
    const principal = await requirePermission("contact:manage");
    const { id, creditLimit, email, ...rest } = data;
    await updateContact(
      principal.orgId,
      id,
      {
        ...rest,
        email: email === "" ? null : email,
        creditLimitMinor: creditLimit ? BigInt(creditLimit) : undefined,
      },
      principal.userId,
    );
    return { ok: true };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Items
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchItems = createServerFn({ method: "GET" })
  .validator(
    z.object({ search: z.string().optional(), includeInactive: z.boolean().optional() }).optional(),
  )
  .handler(async ({ data }) => {
    const { orgId } = await requireAuth();
    const rows = await listItems(orgId, data ?? {});
    return rows.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      description: i.description,
      isInventoryTracked: i.isInventoryTracked,
      unitOfMeasure: i.unitOfMeasure,
      salePrice: money(i.salePriceMinor),
      purchasePrice: money(i.purchasePriceMinor),
      hsnSacCode: i.hsnSacCode,
      isActive: i.isActive,
    }));
  });

const itemInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().max(60).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  isInventoryTracked: z.boolean().optional(),
  unitOfMeasure: z.string().max(20).optional(),
  salePrice: z.string().optional().nullable(),
  purchasePrice: z.string().optional().nullable(),
  hsnSacCode: z.string().max(20).optional().nullable(),
});

export const createItemFn = createServerFn({ method: "POST" })
  .validator(itemInputSchema)
  .handler(async ({ data }) => {
    const principal = await requirePermission("item:manage");
    return createItem(
      principal.orgId,
      {
        name: data.name,
        sku: data.sku ?? null,
        description: data.description ?? null,
        isInventoryTracked: data.isInventoryTracked,
        unitOfMeasure: data.unitOfMeasure,
        salePriceMinor: data.salePrice ? BigInt(data.salePrice) : null,
        purchasePriceMinor: data.purchasePrice ? BigInt(data.purchasePrice) : null,
        hsnSacCode: data.hsnSacCode ?? null,
      },
      principal.userId,
    );
  });

export const updateItemFn = createServerFn({ method: "POST" })
  .validator(
    itemInputSchema.partial().extend({ id: z.string().uuid(), isActive: z.boolean().optional() }),
  )
  .handler(async ({ data }) => {
    const principal = await requirePermission("item:manage");
    const { id, salePrice, purchasePrice, ...rest } = data;
    await updateItem(
      principal.orgId,
      id,
      {
        ...rest,
        salePriceMinor: salePrice ? BigInt(salePrice) : undefined,
        purchasePriceMinor: purchasePrice ? BigInt(purchasePrice) : undefined,
      },
      principal.userId,
    );
    return { ok: true };
  });

/* ────────────────────────────────────────────────────────────────────────────
 * Tax rates
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchTaxRates = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await listTaxRates(orgId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rateBps: r.rateBps,
    ratePercent: r.rateBps / 100,
    isGroup: r.isGroup,
  }));
});

/* ────────────────────────────────────────────────────────────────────────────
 * Banking
 * ──────────────────────────────────────────────────────────────────────────*/

export const fetchBankAccounts = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await listBankAccounts(orgId);
  return rows.map((b) => ({
    id: b.id,
    accountId: b.accountId,
    name: b.name,
    institutionName: b.institutionName,
    accountNumberMasked: b.accountNumberMasked,
    ifscCode: b.ifscCode,
    currency: b.currency,
    feedBalance: money(b.feedBalanceMinor),
    feedLastSyncedAt: b.feedLastSyncedAt?.toISOString() ?? null,
    isActive: b.isActive,
  }));
});

export const fetchBankSummary = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  const rows = await getBankSummary(orgId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    institutionName: r.institution_name,
    accountNumberMasked: r.account_number_masked,
    feedBalance: r.feed_balance_minor,
    glBalance: r.gl_balance_minor,
    unreconciledCount: Number(r.unreconciled_count),
    feedLastSyncedAt: r.feed_last_synced_at,
  }));
});

export const fetchBankTransactions = createServerFn({ method: "GET" })
  .validator(
    z
      .object({
        bankAccountId: z.string().uuid().optional(),
        status: z.string().optional(),
        limit: z.number().max(500).optional(),
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    const { orgId } = await requireAuth();
    const rows = await listBankTransactions(orgId, data ?? {});
    return rows.map((t) => ({
      id: t.id,
      bankAccountId: t.bankAccountId,
      transactionDate: t.transactionDate,
      description: t.description,
      amount: t.amountMinor.toString(),
      currency: t.currency,
      status: t.status,
      matchedEntryId: t.matchedEntryId,
      matchedPaymentId: t.matchedPaymentId,
    }));
  });
