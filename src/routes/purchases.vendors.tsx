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

export const Route = createFileRoute("/purchases/vendors")({
  loader: async () => fetchContacts({ data: { type: "vendor" } }),
  component: Vendors,
});

function Vendors() {
  const vendors = Route.useLoaderData();
  const canManage = useCan("contact:manage");

  return (
    <>
      <PageHeader
        title="Vendors"
        subtitle="Suppliers, contracts, and outstanding payables"
        actions={canManage ? <NewVendorButton /> : undefined}
      />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>GSTIN</TableHead>
                <TableHead className="text-right">Payment terms</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    No vendors yet. Add your first supplier to start recording bills.
                  </TableCell>
                </TableRow>
              ) : (
                vendors.map((v) => (
                  <TableRow key={v.id} className="hover:bg-muted/40">
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-gold text-primary text-xs font-semibold">
                          {v.displayName.slice(0, 1)}
                        </div>
                        <span className="font-medium">{v.displayName}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{v.email ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{v.phone ?? "—"}</TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {v.taxRegistrationNumber ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {v.paymentTermDays != null ? `${v.paymentTermDays} days` : "—"}
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
 * "New Vendor" — opens a dialog, writes through `createContactFn` with
 * type "vendor", then invalidates the router so the loader re-runs and the new
 * row appears without a manual refresh.
 */
function NewVendorButton() {
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
          New Vendor
        </Button>
      }
      title="New vendor"
      description="Add a supplier you can record bills against."
      submitLabel="Create vendor"
      successMessage="Vendor created"
      onSubmit={async () => {
        await createContactFn({
          data: {
            displayName: name,
            type: "vendor",
            email: email || null,
            phone: phone || null,
            taxRegistrationNumber: gstin || null,
            paymentTermDays: Number(terms) || 30,
          },
        });
        setName("");
        setEmail("");
        setPhone("");
        setGstin("");
        await router.invalidate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="vend-name">Vendor name</Label>
        <Input id="vend-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="vend-email">Email</Label>
          <Input
            id="vend-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="vend-phone">Phone</Label>
          <Input id="vend-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="vend-gstin">GSTIN</Label>
          <Input id="vend-gstin" value={gstin} onChange={(e) => setGstin(e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="vend-terms">Payment terms (days)</Label>
          <Input
            id="vend-terms"
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
