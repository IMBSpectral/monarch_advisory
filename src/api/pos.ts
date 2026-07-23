/**
 * Point-of-sale server function.
 *
 * Checkout needs `payment:record` — a till operator settles money, so that's the
 * capability that gates it, consistent with recording any other payment.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { posCheckout } from "@/server/pos";
import { requirePermission } from "@/server/session";

export const posCheckoutFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      method: z.string().min(1),
      lines: z
        .array(
          z.object({
            itemId: z.string().uuid().optional().nullable(),
            description: z.string().min(1),
            quantity: z.string().optional(),
            unitPriceMinor: z.string(),
            taxRateId: z.string().uuid().optional().nullable(),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ data }) => {
    const principal = await requirePermission("payment:record");
    return posCheckout({
      orgId: principal.orgId,
      userId: principal.userId,
      method: data.method,
      saleDate: new Date().toISOString().slice(0, 10),
      lines: data.lines.map((l) => ({
        itemId: l.itemId ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: BigInt(l.unitPriceMinor),
        taxRateId: l.taxRateId ?? null,
      })),
    });
  });
