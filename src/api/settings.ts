/**
 * Org-level settings that aren't identity (name/role) — currently the maker-
 * checker approval threshold.
 */
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db/client";
import { organizations } from "@/db/schema";
import { requireAuth, requirePermission } from "@/server/session";

/** The current approval threshold (minor units) for this org, or null if off. */
export const fetchApprovalSettings = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return withOrg(orgId, async (tx) => {
    const [org] = await tx
      .select({ threshold: organizations.approvalThresholdMinor })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return { approvalThresholdMinor: org?.threshold != null ? org.threshold.toString() : null };
  });
});

/**
 * Set (or clear) the approval threshold. A bill at or above it must be posted by
 * someone other than its creator. Pass null / empty to switch approvals off.
 */
export const updateApprovalThresholdFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      // A non-negative integer string in minor units (empty = off), or null.
      thresholdMinor: z.string().regex(/^\d*$/, "Enter a whole amount in minor units.").nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const p = await requirePermission("settings:manage");
    const value =
      data.thresholdMinor === null || data.thresholdMinor === ""
        ? null
        : BigInt(data.thresholdMinor);
    await withOrg(p.orgId, (tx) =>
      tx
        .update(organizations)
        .set({ approvalThresholdMinor: value, updatedAt: new Date() })
        .where(eq(organizations.id, p.orgId)),
    );
    return { approvalThresholdMinor: value != null ? value.toString() : null };
  });
