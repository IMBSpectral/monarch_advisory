import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { leads, inr } from "@/data/mock";

export const Route = createFileRoute("/crm/")({ component: CRM });

const stages = ["Leads", "Qualified", "Proposal", "Negotiation", "Won"];

function CRM() {
  return (
    <>
      <PageHeader title="CRM" subtitle="Track leads through your pipeline"
        actions={<Button size="sm" className="bg-gradient-brand text-white"><Plus className="h-4 w-4 mr-1.5" />New Lead</Button>} />
      <div className="p-6 overflow-x-auto">
        <div className="flex gap-4 min-w-max">
          {stages.map((stage) => {
            const stageLeads = leads.filter(l => l.stage === stage);
            const total = stageLeads.reduce((s, l) => s + l.value, 0);
            return (
              <div key={stage} className="w-72 flex-shrink-0">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-brand" />
                    <h3 className="font-semibold text-sm">{stage}</h3>
                    <Badge variant="secondary" className="text-[10px]">{stageLeads.length}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">{inr(total)}</span>
                </div>
                <div className="space-y-2">
                  {stageLeads.map((l) => (
                    <Card key={l.name} className="p-3 hover:shadow-elegant hover:border-brand/50 cursor-pointer transition-all">
                      <p className="font-medium text-sm">{l.name}</p>
                      <p className="text-xs text-muted-foreground mt-1">{l.source}</p>
                      <div className="flex items-center justify-between mt-3">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{l.owner.split(" ").map(w => w[0]).join("")}</div>
                        <span className="text-sm font-semibold tabular-nums text-brand">{inr(l.value)}</span>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
