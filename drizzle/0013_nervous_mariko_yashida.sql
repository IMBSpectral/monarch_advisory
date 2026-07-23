CREATE TABLE "stock_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"received_at" date NOT NULL,
	"original_qty" numeric(18, 4) NOT NULL,
	"remaining_qty" numeric(18, 4) NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"source_movement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "foreign_total_minor" bigint;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_source_movement_id_stock_movements_id_fk" FOREIGN KEY ("source_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slayer_fifo_idx" ON "stock_layers" USING btree ("org_id","item_id","warehouse_id","received_at");
--> statement-breakpoint
ALTER TABLE "stock_layers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_layers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS stock_layers_tenant_isolation ON stock_layers;--> statement-breakpoint
CREATE POLICY stock_layers_tenant_isolation ON stock_layers
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
