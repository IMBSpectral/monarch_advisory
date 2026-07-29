/**
 * The maker-checker approval queue API — list pending items and approve/reject
 * them. Approving replays the stored operation with the approver's identity; the
 * approver must hold the same capability the operation itself requires, and must
 * not be the person who submitted it (enforced in the service).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/server/session";
import { assertCan } from "@/server/auth";
import {
  APPROVAL_CAPABILITY,
  approvePending,
  listPendingApprovals,
  pendingOperation,
  rejectPending,
} from "@/server/approval-queue";

export const fetchPendingApprovals = createServerFn({ method: "GET" }).handler(async () => {
  const { orgId } = await requireAuth();
  return listPendingApprovals(orgId);
});

export const approvePendingFn = createServerFn({ method: "POST" })
  .validator(z.object({ pendingId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const principal = await requireAuth();
    const op = await pendingOperation(principal.orgId, data.pendingId);
    if (!op) throw new Error("This request no longer exists.");
    // The approver needs the same authority the operation itself requires.
    assertCan(principal, APPROVAL_CAPABILITY[op] as Parameters<typeof assertCan>[1]);
    return approvePending({
      orgId: principal.orgId,
      pendingId: data.pendingId,
      approverId: principal.userId,
    });
  });

export const rejectPendingFn = createServerFn({ method: "POST" })
  .validator(z.object({ pendingId: z.string().uuid(), reason: z.string().min(1).max(500) }))
  .handler(async ({ data }) => {
    const principal = await requireAuth();
    return rejectPending({
      orgId: principal.orgId,
      pendingId: data.pendingId,
      userId: principal.userId,
      reason: data.reason,
    });
  });
