CREATE TYPE "public"."stock_move_source" AS ENUM('purchase', 'sale', 'sales_return', 'purchase_return', 'adjustment', 'transfer_out', 'transfer_in', 'opening_balance', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."valuation_method" AS ENUM('weighted_average', 'fifo');--> statement-breakpoint
CREATE TABLE "item_stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"on_hand_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"value_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stocklevel_value_nonneg" CHECK ("item_stock_levels"."value_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"move_date" date NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"value_minor" bigint NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"source" "stock_move_source" NOT NULL,
	"source_document_id" uuid,
	"je_id" uuid,
	"memo" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "smove_nonzero_qty" CHECK ("stock_movements"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "cogs_account_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "valuation_method" "valuation_method" DEFAULT 'weighted_average' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reorder_level" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "item_stock_levels" ADD CONSTRAINT "item_stock_levels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_stock_levels" ADD CONSTRAINT "item_stock_levels_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_stock_levels" ADD CONSTRAINT "item_stock_levels_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_je_id_journal_entries_id_fk" FOREIGN KEY ("je_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stocklevel_item_wh_idx" ON "item_stock_levels" USING btree ("item_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stocklevel_org_idx" ON "item_stock_levels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "smove_org_item_wh_idx" ON "stock_movements" USING btree ("org_id","item_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "smove_org_date_idx" ON "stock_movements" USING btree ("org_id","move_date");--> statement-breakpoint
CREATE INDEX "smove_source_doc_idx" ON "stock_movements" USING btree ("source","source_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_org_code_idx" ON "warehouses" USING btree ("org_id","code");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_cogs_account_id_accounts_id_fk" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security for the new inventory tables (same pattern as 0002).
-- Without this, the stock ledger would be globally readable while every other
-- financial table is tenant-isolated.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY['warehouses', 'stock_movements', 'item_stock_levels'];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (org_id = current_setting(''app.org_id'', true)::uuid)
         WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- The stock ledger is append-only, like journal_lines. Deny mutation to the app
-- role so a corrected movement must be a compensating movement, never an edit.
REVOKE UPDATE, DELETE ON stock_movements FROM monarch_app;
--> statement-breakpoint
-- At most one default warehouse per org.
CREATE UNIQUE INDEX "warehouse_one_default_per_org" ON "warehouses" ("org_id") WHERE "is_default";
--> statement-breakpoint
-- Give every existing org a default warehouse so current documents resolve.
-- (The seed also creates one for freshly-seeded orgs.)
INSERT INTO warehouses (org_id, code, name, is_default)
SELECT id, 'MAIN', 'Main Warehouse', true FROM organizations
ON CONFLICT (org_id, code) DO NOTHING;
