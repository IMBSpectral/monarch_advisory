ALTER TABLE "stock_layers" ADD COLUMN "remaining_value_minor" bigint;--> statement-breakpoint
UPDATE "stock_layers" SET "remaining_value_minor" = round("remaining_qty" * "unit_cost_minor");--> statement-breakpoint
ALTER TABLE "stock_layers" ALTER COLUMN "remaining_value_minor" SET NOT NULL;
