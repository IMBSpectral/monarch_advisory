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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntityFormDialog } from "@/components/EntityFormDialog";
import { useCan } from "@/components/SessionContext";
import { fetchContacts, createContactFn } from "@/api/entities";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/sales/customers")({
  loader: async () => fetchContacts({ data: { type: "customer" } }),
  component: Customers,
});

function Customers() {
  const customers = Route.useLoaderData();
  const canManage = useCan("contact:manage");

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="360° view of every buyer relationship"
        actions={canManage ? <NewCustomerButton /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead className="text-right">Credit limit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No customers yet. Add your first one to start invoicing.
                  </TableCell>
                </TableRow>
              ) : (
                customers.map((c) => (
                  <TableRow key={c.id} className="hover:bg-muted/40">
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div className="bg-gradient-brand flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white">
                          {c.displayName.slice(0, 1)}
                        </div>
                        <span className="font-medium">{c.displayName}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.email ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.phone ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {c.taxRegistrationNumber ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {c.creditLimit ? formatMinor(c.creditLimit) : "—"}
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

/**
 * "New Customer" — opens a dialog, writes through `createContactFn`, then
 * invalidates the router so the loader re-runs and the new row appears without
 * a manual refresh.
 */
function NewCustomerButton() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");
  const [terms, setTerms] = useState("30");

  return (
    <EntityFormDialog
      trigger={
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="mr-1.5 h-4 w-4" />
          New Customer
        </Button>
      }
      title="New customer"
      description="Add a buyer you can raise invoices against."
      submitLabel="Create customer"
      successMessage="Customer created"
      onSubmit={async () => {
        await createContactFn({
          data: {
            displayName: name,
            type: "customer",
            email: email || null,
            phone: phone || null,
            taxRegistrationNumber: gstin || null,
            paymentTermDays: Number(terms) || 30,
          },
        });
        // Reset for the next open, and re-run the loader.
        setName("");
        setEmail("");
        setPhone("");
        setGstin("");
        await router.invalidate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="cust-name">Name</Label>
        <Input id="cust-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="cust-email">Email</Label>
          <Input
            id="cust-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cust-phone">Phone</Label>
          <Input id="cust-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="cust-gstin">GSTIN</Label>
          <Input id="cust-gstin" value={gstin} onChange={(e) => setGstin(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cust-terms">Payment terms (days)</Label>
          <Input
            id="cust-terms"
            type="number"
            min={0}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </div>
      </div>
    </EntityFormDialog>
  );
}
