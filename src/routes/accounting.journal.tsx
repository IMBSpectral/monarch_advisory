import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { journals, inr } from "@/data/mock";

export const Route = createFileRoute("/accounting/journal")({ component: Journals });

function Journals() {
  return (
    <>
      <PageHeader title="Journal Entries" subtitle="Double-entry postings across all accounts"
        actions={<Button size="sm" className="bg-gradient-brand text-white"><Plus className="h-4 w-4 mr-1.5" />New Entry</Button>} />
      <div className="p-6">
        <Card>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Entry #</TableHead><TableHead>Date</TableHead><TableHead>Reference</TableHead><TableHead>Memo</TableHead><TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {journals.map((j) => (
                <TableRow key={j.id} className="hover:bg-muted/40">
                  <TableCell className="font-mono text-xs text-brand">{j.id}</TableCell>
                  <TableCell className="text-muted-foreground">{j.date}</TableCell>
                  <TableCell className="font-mono text-xs">{j.ref}</TableCell>
                  <TableCell>{j.memo}</TableCell>
                  <TableCell className="text-right tabular-nums">{inr(j.debit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{inr(j.credit)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
