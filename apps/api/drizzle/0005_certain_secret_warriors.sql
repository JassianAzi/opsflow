ALTER TABLE "workflow_executions" ADD COLUMN "error_type" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "processing_token" uuid;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workflow_executions_status_lease_idx" ON "workflow_executions" USING btree ("status","processing_lease_expires_at");--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_processing_lease_consistent" CHECK (("workflow_executions"."processing_token" IS NULL) = ("workflow_executions"."processing_lease_expires_at" IS NULL));