CREATE TYPE "public"."execution_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."execution_step_status" AS ENUM('pending', 'running', 'completed', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."queue_outbox_status" AS ENUM('pending', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "execution_queue_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"job_payload" jsonb NOT NULL,
	"status" "queue_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_queue_outbox_attempt_count_nonnegative" CHECK ("execution_queue_outbox"."attempt_count" >= 0),
	CONSTRAINT "execution_queue_outbox_payload_matches_execution" CHECK ("execution_queue_outbox"."job_payload" = jsonb_build_object('executionId', "execution_queue_outbox"."execution_id"::text))
);
--> statement-breakpoint
CREATE TABLE "execution_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"workflow_step_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"step_type" "workflow_step_type" NOT NULL,
	"action_type" "workflow_action_type",
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"retry_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "execution_step_status" DEFAULT 'pending' NOT NULL,
	"input_data" jsonb,
	"output_data" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_type" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_steps_order_nonnegative" CHECK ("execution_steps"."step_order" >= 0),
	CONSTRAINT "execution_steps_attempt_count_nonnegative" CHECK ("execution_steps"."attempt_count" >= 0),
	CONSTRAINT "execution_steps_action_type_consistent" CHECK (("execution_steps"."step_type" = 'condition' AND "execution_steps"."action_type" IS NULL) OR ("execution_steps"."step_type" = 'action' AND "execution_steps"."action_type" IS NOT NULL)),
	CONSTRAINT "execution_steps_config_object" CHECK (jsonb_typeof("execution_steps"."config") = 'object'),
	CONSTRAINT "execution_steps_retry_config_object" CHECK (jsonb_typeof("execution_steps"."retry_config") = 'object'),
	CONSTRAINT "execution_steps_timestamps_ordered" CHECK ("execution_steps"."started_at" IS NULL OR "execution_steps"."completed_at" IS NULL OR "execution_steps"."started_at" <= "execution_steps"."completed_at")
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version" integer NOT NULL,
	"trigger_type" "workflow_trigger_type" NOT NULL,
	"trigger_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_snapshot" jsonb NOT NULL,
	"idempotency_key" text,
	"status" "execution_status" DEFAULT 'queued' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	CONSTRAINT "workflow_executions_version_positive" CHECK ("workflow_executions"."workflow_version" >= 1),
	CONSTRAINT "workflow_executions_trigger_payload_object" CHECK (jsonb_typeof("workflow_executions"."trigger_payload") = 'object'),
	CONSTRAINT "workflow_executions_snapshot_object" CHECK (jsonb_typeof("workflow_executions"."workflow_snapshot") = 'object'),
	CONSTRAINT "workflow_executions_timestamps_ordered" CHECK ("workflow_executions"."started_at" IS NULL OR "workflow_executions"."completed_at" IS NULL OR "workflow_executions"."started_at" <= "workflow_executions"."completed_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_id_organization_unique" ON "workflows" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "execution_queue_outbox" ADD CONSTRAINT "execution_queue_outbox_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_org_fk" FOREIGN KEY ("workflow_id","organization_id") REFERENCES "public"."workflows"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_queue_outbox_execution_unique" ON "execution_queue_outbox" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_queue_outbox_dispatch_idx" ON "execution_queue_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_steps_execution_order_unique" ON "execution_steps" USING btree ("execution_id","step_order");--> statement-breakpoint
CREATE INDEX "execution_steps_execution_status_idx" ON "execution_steps" USING btree ("execution_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_workflow_idempotency_unique" ON "workflow_executions" USING btree ("workflow_id","idempotency_key") WHERE "workflow_executions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_executions_org_queued_idx" ON "workflow_executions" USING btree ("organization_id","queued_at");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_queued_idx" ON "workflow_executions" USING btree ("workflow_id","queued_at");--> statement-breakpoint
CREATE INDEX "workflow_executions_status_queued_idx" ON "workflow_executions" USING btree ("status","queued_at");
