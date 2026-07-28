import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Download, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NewInvoiceDialog } from "@/components/NewInvoiceDialog";
import { useCan, useSession } from "@/components/SessionContext";
import { fetchInvoices, postInvoiceFn } from "@/api";
import { fetchApprovalSettings } from "@/api/settings";
import { fetchContacts, fetchTaxRates } from "@/api/entities";
import { formatMinor } from "@/lib/money";
import { downloadCsv } from "@/lib/export";

export const Route = createFileRoute("/sales/invoices/")({
  loader: async () => {
    // The list plus what the "New Invoice" form needs, in parallel.
    const [invoices, customers, taxRates, approval] = await Promise.all([
      fetchInvoices({ data: {} }),
      fetchContacts({ data: { type: "customer" } }),
      fetchTaxRates(),
      fetchApprovalSettings(),
    ]);
    return { invoices, customers, taxRates, approval };
  },
  component: Invoices,
});

/** Ledger invoice statuses → badge styling. */
const statusStyle: Record<string, string> = {
  paid: "bg-success/10 text-success border-success/20",
  sent: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  overdue: "bg-destructive/10 text-destructive border-destructive/20",
  partially_paid: "bg-warning/10 text-warning-foreground border-warning/30",
  draft: "bg-muted text-muted-foreground border-border",
  void: "bg-muted text-muted-foreground line-through border-border",
};

const statusLabel: Record<string, string> = {
  paid: "Paid",
  sent: "Sent",
  overdue: "Overdue",
  partially_paid: "Partial",
  draft: "Draft",
  void: "Void",
  written_off: "Written off",
};

function Invoices() {
  const { invoices, customers, taxRates, approval } = Route.useLoaderData();
  const canCreate = useCan("document:create");
  const canPost = useCan("ledger:post");
  const session = useSession();
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [postingId, setPostingId] = useState<string | null>(null);

  const threshold = approval.approvalThresholdMinor
    ? BigInt(approval.approvalThresholdMinor)
    : null;
  const needsApproval = (i: (typeof invoices)[number]) =>
    threshold !== null && BigInt(i.total) >= threshold;

  async function post(i: (typeof invoices)[number]) {
    setPostingId(i.id);
    try {
      await postInvoiceFn({ data: { invoiceId: i.id } });
      toast.success(`${i.invoiceNumber} posted.`);
      await router.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not post the invoice.");
    } finally {
      setPostingId(null);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return invoices.filter((i) => {
      if (status !== "all" && i.status !== status) return false;
      if (!q) return true;
      return (
        i.invoiceNumber.toLowerCase().includes(q) ||
        (i.customerName ?? "").toLowerCase().includes(q)
      );
    });
  }, [invoices, search, status]);

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="Manage customer invoices, payments, and reminders"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadCsv(
                  "invoices.csv",
                  ["Invoice", "Customer", "Date", "Due", "Total", "Balance", "Status"],
                  filtered.map((i) => [
                    i.invoiceNumber,
                    i.customerName ?? "",
                    i.invoiceDate,
                    i.dueDate,
                    formatMinor(i.total, { showPaise: true }),
                    formatMinor(i.balance, { showPaise: true }),
                    statusLabel[i.status] ?? i.status,
                  ]),
                )
              }
            >
              <Download className="mr-1.5 h-4 w-4" />
              Export
            </Button>
            {canCreate ? (
              <NewInvoiceDialog customers={customers} taxRates={taxRates} canPost={canPost} />
            ) : null}
          </>
        }
      />
      <div className="space-y-4 p-6">
        {threshold !== null ? (
          <p className="text-sm text-muted-foreground">
            Approvals on — an invoice at or above{" "}
            <span className="font-medium">{formatMinor(threshold, { showPaise: false })}</span> must
            be posted by someone other than the person who raised it.
          </p>
        ) : null}
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by number or customer…"
                className="h-9 pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="partially_paid">Partially paid</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                    {invoices.length === 0
                      ? "No invoices yet. Create your first one."
                      : "No invoices match your filters."}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((i) => (
                  <TableRow key={i.id} className="hover:bg-muted/40">
                    <TableCell>
                      <Link
                        to="/sales/invoices/$id"
                        params={{ id: i.id }}
                        className="text-brand font-medium hover:underline"
                      >
                        {i.invoiceNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{i.customerName}</TableCell>
                    <TableCell className="text-muted-foreground">{i.invoiceDate}</TableCell>
                    <TableCell className="text-muted-foreground">{i.dueDate}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMinor(i.total)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinor(i.balance)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={statusStyle[i.status] ?? ""}>
                          {statusLabel[i.status] ?? i.status}
                        </Badge>
                        {i.status === "draft" && needsApproval(i) ? (
                          <Badge
                            variant="outline"
                            className="border-warning/30 bg-warning/10 text-warning-foreground"
                          >
                            Needs approval
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {i.status === "draft" && canPost ? (
                        needsApproval(i) && session?.userId === i.createdByUserId ? (
                          <span className="text-xs text-muted-foreground">
                            Another user must approve
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={postingId === i.id}
                            onClick={() => post(i)}
                          >
                            {postingId === i.id ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            {needsApproval(i) ? "Approve & post" : "Post"}
                          </Button>
                        )
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
