import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDetail } from '@opsflow/shared';
import {
  activationGuardMessage,
  confirmDiscardChanges,
  isWorkflowDraftDirty,
  SAVE_BEFORE_ACTIVATING,
  type WorkflowDraft,
} from './workflow-editor.js';

const loaded: WorkflowDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  name: 'Customer follow-up',
  description: 'Contact active customers',
  status: 'draft',
  triggerType: 'manual',
  triggerConfig: {},
  version: 2,
  createdBy: '00000000-0000-4000-8000-000000000003',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  steps: [
    {
      id: '00000000-0000-4000-8000-000000000004',
      workflowId: '00000000-0000-4000-8000-000000000001',
      stepOrder: 0,
      stepType: 'action',
      actionType: 'log',
      name: 'Log',
      config: { message: 'Ready', context: { source: 'manual' } },
      retryConfig: {},
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  ],
};

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    name: loaded.name,
    description: loaded.description,
    triggerType: loaded.triggerType,
    triggerConfig: {},
    steps: [
      {
        stepType: 'action',
        actionType: 'log',
        name: 'Log',
        config: { context: { source: 'manual' }, message: 'Ready' },
        retryConfig: {},
      },
    ],
    ...overrides,
  };
}

describe('workflow editor draft protection', () => {
  it('treats an unchanged loaded workflow as clean regardless of JSON key order', () => {
    expect(isWorkflowDraftDirty(loaded, draft())).toBe(false);
  });

  it('detects unsaved metadata and step changes', () => {
    expect(isWorkflowDraftDirty(loaded, draft({ name: 'Changed' }))).toBe(true);
    expect(
      isWorkflowDraftDirty(
        loaded,
        draft({
          steps: [
            {
              ...draft().steps[0]!,
              config: { message: 'Unsaved' },
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('blocks a dirty discard when confirmation is declined and describes the loss', () => {
    const confirm = vi.fn(() => false);
    expect(
      confirmDiscardChanges(
        true,
        loaded.name,
        'Open another workflow?',
        confirm,
      ),
    ).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      'Open another workflow? Unsaved changes to “Customer follow-up” will be lost.',
    );
  });

  it('allows clean actions without prompting and provides the activation guard message', () => {
    const confirm = vi.fn(() => false);
    expect(
      confirmDiscardChanges(false, loaded.name, 'Close the editor?', confirm),
    ).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(activationGuardMessage(false)).toBeNull();
    expect(activationGuardMessage(true)).toBe(SAVE_BEFORE_ACTIVATING);
  });
});
