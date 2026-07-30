ALTER TABLE "bills" ADD COLUMN "reverse_charge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "itc_eligible" boolean DEFAULT true NOT NULL;