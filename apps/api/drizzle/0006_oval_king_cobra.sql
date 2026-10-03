ALTER TABLE "workflow_executions" ADD COLUMN "processing_attempt" integer;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "reconciliation_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "reconciliation_available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "reconciliation_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "reconciliation_lock_token" uuid;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "reconciliation_last_error" text;--> statement-breakpoint
UPDATE "workflow_executions"
SET "processing_attempt" = 0
WHERE "processing_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_executions_reconciliation_due_idx" ON "workflow_executions" USING btree ("status","reconciliation_available_at");--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_processing_attempt_consistent" CHECK (("workflow_executions"."processing_token" IS NULL) = ("workflow_executions"."processing_attempt" IS NULL));--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_processing_attempt_nonnegative" CHECK ("workflow_executions"."processing_attempt" IS NULL OR "workflow_executions"."processing_attempt" >= 0);--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_reconciliation_attempt_nonnegative" CHECK ("workflow_executions"."reconciliation_attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_reconciliation_lock_consistent" CHECK (("workflow_executions"."reconciliation_locked_at" IS NULL) = ("workflow_executions"."reconciliation_lock_token" IS NULL));
