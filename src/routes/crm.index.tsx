import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Info } from "lucide-react";
import { EntityFormDialog } from "@/components/EntityFormDialog";
import { useCan } from "@/components/SessionContext";
import { createContactFn } from "@/api/entities";
import { leads, inr } from "@/data/mock";

export const Route = createFileRoute("/crm/")({ component: CRM });

const stages = ["Leads", "Qualified", "Proposal", "Negotiation", "Won"];

function CRM() {
  const canManage = useCan("contact:manage");

  return (
    <>
      <PageHeader
        title="CRM"
        subtitle="Track leads through your pipeline"
        actions={canManage ? <NewLeadButton /> : undefined}
      />
      <div className="p-6 space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-brand/20 bg-brand/5 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Sample pipeline</span> — connect your CRM
            source to populate stages with live deals. New leads you add here are saved as real
            customer contacts you can invoice.
          </p>
        </div>
        <div className="overflow-x-auto">
          <div className="flex gap-4 min-w-max">
            {stages.map((stage) => {
              const stageLeads = leads.filter((l) => l.stage === stage);
              const total = stageLeads.reduce((s, l) => s + l.value, 0);
              return (
                <div key={stage} className="w-72 flex-shrink-0">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-brand" />
                      <h3 className="font-semibold text-sm">{stage}</h3>
                      <Badge variant="secondary" className="text-[10px]">
                        {stageLeads.length}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">{inr(total)}</span>
                  </div>
                  <div className="space-y-2">
                    {stageLeads.map((l) => (
                      <Card
                        key={l.name}
                        className="p-3 hover:shadow-elegant hover:border-brand/50 cursor-pointer transition-all"
                      >
                        <p className="font-medium text-sm">{l.name}</p>
                        <p className="text-xs text-muted-foreground mt-1">{l.source}</p>
                        <div className="flex items-center justify-between mt-3">
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">
                            {l.owner
                              .split(" ")
                              .map((w) => w[0])
                              .join("")}
                          </div>
                          <span className="text-sm font-semibold tabular-nums text-brand">
                            {inr(l.value)}
                          </span>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * "New Lead" — captures a prospect and saves it as a real customer contact via
 * `createContactFn`, then invalidates the router so any contact-backed views
 * refresh. Turning a qualified lead into a contact you can invoice is the one
 * step of the pipeline that maps onto real data today.
 */
function NewLeadButton() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  return (
    <EntityFormDialog
      trigger={
        <Button size="sm" className="bg-gradient-brand text-white">
          <Plus className="h-4 w-4 mr-1.5" />
          New Lead
        </Button>
      }
      title="New lead"
      description="Capture a prospect. It's saved as a customer contact you can raise invoices against."
      submitLabel="Create lead"
      successMessage="Lead saved as customer contact"
      onSubmit={async () => {
        await createContactFn({
          data: {
            displayName: name,
            type: "customer",
            email: email || null,
            phone: phone || null,
          },
        });
        setName("");
        setEmail("");
        setPhone("");
        await router.invalidate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="lead-name">Name</Label>
        <Input id="lead-name" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="lead-email">Email</Label>
          <Input
            id="lead-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="lead-phone">Phone</Label>
          <Input id="lead-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
    </EntityFormDialog>
  );
}
