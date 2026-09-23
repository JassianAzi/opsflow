import type { WorkflowDetail, WorkflowStepInput } from '@opsflow/shared';

export interface WorkflowDraft {
  name: string;
  description: string;
  triggerType: WorkflowDetail['triggerType'];
  triggerConfig: Record<string, unknown>;
  steps: WorkflowStepInput[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function editableSteps(workflow: WorkflowDetail): WorkflowStepInput[] {
  return workflow.steps.map(
    ({ stepType, actionType, name, config, retryConfig }) => ({
      stepType,
      actionType,
      name,
      config,
      retryConfig,
    }),
  );
}

export function isWorkflowDraftDirty(
  loaded: WorkflowDetail | null,
  draft: WorkflowDraft,
): boolean {
  if (!loaded) return false;
  return (
    stableJson({
      name: loaded.name,
      description: loaded.description,
      triggerType: loaded.triggerType,
      triggerConfig: loaded.triggerConfig,
      steps: editableSteps(loaded),
    }) !== stableJson(draft)
  );
}

export function confirmDiscardChanges(
  dirty: boolean,
  workflowName: string,
  action: string,
  confirm: (message: string) => boolean,
): boolean {
  if (!dirty) return true;
  return confirm(
    `${action} Unsaved changes to “${workflowName}” will be lost.`,
  );
}

export const SAVE_BEFORE_ACTIVATING =
  'Save your changes before activating this workflow.';

export function activationGuardMessage(dirty: boolean): string | null {
  return dirty ? SAVE_BEFORE_ACTIVATING : null;
}
