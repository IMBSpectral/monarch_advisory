import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Plus } from "lucide-react";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityFormDialog } from "@/components/EntityFormDialog";
import { useCan } from "@/components/SessionContext";
import { createAccountFn, fetchChartOfAccounts } from "@/api";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/accounting/coa")({
  loader: async () => fetchChartOfAccounts(),
  component: CoA,
});

const typeColor: Record<string, string> = {
  asset: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  liability: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  equity: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  income: "bg-success/10 text-success border-success/20",
  expense: "bg-destructive/10 text-destructive border-destructive/20",
};

const typeLabel: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

/** The subtypes that make sense under each type, in the same order as the enum. */
const SUBTYPES_BY_TYPE: Record<AccountType, { value: string; label: string }[]> = {
  asset: [
    { value: "cash_and_bank", label: "Cash & Bank" },
    { value: "accounts_receivable", label: "Accounts Receivable" },
    { value: "inventory", label: "Inventory" },
    { value: "other_current_asset", label: "Other Current Asset" },
    { value: "fixed_asset", label: "Fixed Asset" },
    { value: "accumulated_depreciation", label: "Accumulated Depreciation" },
    { value: "other_asset", label: "Other Asset" },
  ],
  liability: [
    { value: "accounts_payable", label: "Accounts Payable" },
    { value: "credit_card", label: "Credit Card" },
    { value: "tax_payable", label: "Tax Payable" },
    { value: "other_current_liability", label: "Other Current Liability" },
    { value: "long_term_liability", label: "Long-term Liability" },
    { value: "goods_received_clearing", label: "Goods Received (Clearing)" },
  ],
  equity: [
    { value: "equity", label: "Equity" },
    { value: "retained_earnings", label: "Retained Earnings" },
  ],
  income: [
    { value: "operating_revenue", label: "Operating Revenue" },
    { value: "other_income", label: "Other Income" },
  ],
  expense: [
    { value: "cost_of_goods_sold", label: "Cost of Goods Sold" },
    { value: "operating_expense", label: "Operating Expense" },
    { value: "depreciation_expense", label: "Depreciation Expense" },
    { value: "other_expense", label: "Other Expense" },
  ],
};

function CoA() {
  const accounts = Route.useLoaderData();
  const canManage = useCan("settings:manage");

  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        subtitle="Hierarchical ledger structure"
        actions={canManage ? <NewAccountButton /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Code</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Subtype</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No accounts configured yet.
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a) => (
                  <TableRow
                    key={a.id}
                    className={a.isGroup ? "bg-muted/30 font-semibold" : "hover:bg-muted/40"}
                  >
                    <TableCell className="font-mono text-xs">{a.code}</TableCell>
                    <TableCell
                      className={a.isGroup ? "text-muted-foreground" : ""}
                      style={{ paddingLeft: a.parentId ? "40px" : undefined }}
                    >
                      {a.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={typeColor[a.type]}>
                        {typeLabel[a.type] ?? a.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs capitalize">
                      {a.subtype ? a.subtype.replace(/_/g, " ") : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMinor(a.balance)}
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

/** "New account" — create a postable ledger account. Admin-gated (settings:manage). */
function NewAccountButton() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<AccountType>("expense");
  const [subtype, setSubtype] = useState<string>("operating_expense");

  return (
    <EntityFormDialog
      trigger={
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New account
        </Button>
      }
      title="New account"
      description="Add a postable account to your chart of accounts."
      submitLabel="Create account"
      successMessage="Account created"
      onSubmit={async () => {
        if (!name.trim()) throw new Error("An account name is required.");
        await createAccountFn({
          data: {
            name: name.trim(),
            code: code.trim() || undefined,
            type,
            subtype: subtype as never,
          },
        });
        setName("");
        setCode("");
        setType("expense");
        setSubtype("operating_expense");
        await router.invalidate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="acc-name">Name</Label>
        <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="acc-type">Type</Label>
          <Select
            value={type}
            onValueChange={(v) => {
              const t = v as AccountType;
              setType(t);
              // Keep subtype valid for the new type.
              setSubtype(SUBTYPES_BY_TYPE[t][0].value);
            }}
          >
            <SelectTrigger id="acc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SUBTYPES_BY_TYPE) as AccountType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {typeLabel[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="acc-subtype">Subtype</Label>
          {/* Remount when the type changes so the controlled value re-syncs with
              the new option set (Radix Select can otherwise blank out when both
              the value and the items change in one render). */}
          <Select key={type} value={subtype} onValueChange={setSubtype}>
            <SelectTrigger id="acc-subtype">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBTYPES_BY_TYPE[type].map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="acc-code">Code (optional)</Label>
        <Input
          id="acc-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Auto-numbered if left blank"
        />
      </div>
    </EntityFormDialog>
  );
}
