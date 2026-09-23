import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  ActionType,
  TriggerType,
  WorkflowDetail,
  WorkflowStepInput,
  WorkflowSummary,
} from '@opsflow/shared';
import {
  actionTypeSchema,
  conditionOperatorSchema,
  createWorkflowInputSchema,
  updateWorkflowInputSchema,
} from '@opsflow/shared';
import { api } from './api';
import {
  activationGuardMessage,
  confirmDiscardChanges,
  isWorkflowDraftDirty,
} from './workflow-editor';

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-cyan-500';
const buttonClass =
  'rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50';

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed.';
}
function value(config: Record<string, unknown>, key: string): string {
  const item = config[key];
  return typeof item === 'string' || typeof item === 'number'
    ? String(item)
    : '';
}
function newAction(type: ActionType): WorkflowStepInput {
  const defaults: Record<ActionType, Record<string, unknown>> = {
    log: { message: '' },
    internal_task: { title: '', description: '' },
    mock_email: { to: '', subject: '', body: '' },
    http_request: { method: 'GET', url: '', headers: {} },
    ai: { operation: 'classify', prompt: '' },
  };
  return {
    stepType: 'action',
    actionType: type,
    name: `${type.replaceAll('_', ' ')} action`,
    config: defaults[type],
    retryConfig: {},
  };
}

function StepFields({
  step,
  change,
}: {
  step: WorkflowStepInput;
  change: (step: WorkflowStepInput) => void;
}) {
  const set = (key: string, next: unknown) =>
    change({ ...step, config: { ...step.config, [key]: next } });
  const field = (
    label: string,
    key: string,
    options?: { multiline?: boolean; type?: string },
  ) => (
    <label className="block text-xs text-slate-400">
      {label}
      {options?.multiline ? (
        <textarea
          className={`${inputClass} mt-1 min-h-20`}
          value={value(step.config, key)}
          onChange={(event) => set(key, event.target.value)}
        />
      ) : (
        <input
          className={`${inputClass} mt-1`}
          type={options?.type ?? 'text'}
          value={value(step.config, key)}
          onChange={(event) => set(key, event.target.value)}
        />
      )}
    </label>
  );
  if (step.stepType === 'condition')
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {field('Field path', 'field')}
        <label className="block text-xs text-slate-400">
          Operator
          <select
            className={`${inputClass} mt-1`}
            value={value(step.config, 'operator')}
            onChange={(event) => {
              const operator = event.target.value;
              const config: Record<string, unknown> = {
                ...step.config,
                operator,
              };
              if (operator === 'exists' || operator === 'does_not_exist')
                delete config.value;
              else if (config.value === undefined)
                config.value =
                  operator === 'greater_than' || operator === 'less_than'
                    ? 0
                    : '';
              change({ ...step, config });
            }}
          >
            {conditionOperatorSchema.options.map((operator) => (
              <option key={operator} value={operator}>
                {operator.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        {!['exists', 'does_not_exist'].includes(
          value(step.config, 'operator'),
        ) && (
          <label className="block text-xs text-slate-400 sm:col-span-2">
            Value
            <input
              className={`${inputClass} mt-1`}
              type={
                ['greater_than', 'less_than'].includes(
                  value(step.config, 'operator'),
                )
                  ? 'number'
                  : 'text'
              }
              value={value(step.config, 'value')}
              onChange={(event) =>
                set(
                  'value',
                  ['greater_than', 'less_than'].includes(
                    value(step.config, 'operator'),
                  )
                    ? Number(event.target.value)
                    : event.target.value,
                )
              }
            />
          </label>
        )}
      </div>
    );
  switch (step.actionType) {
    case 'log':
      return field('Message', 'message', { multiline: true });
    case 'internal_task':
      return (
        <div className="space-y-3">
          {field('Task title', 'title')}
          {field('Description', 'description', { multiline: true })}
        </div>
      );
    case 'mock_email':
      return (
        <div className="space-y-3">
          {field('To', 'to', { type: 'email' })}
          {field('Subject', 'subject')}
          {field('Body', 'body', { multiline: true })}
        </div>
      );
    case 'http_request':
      return (
        <div className="space-y-3">
          <label className="block text-xs text-slate-400">
            Method
            <select
              className={`${inputClass} mt-1`}
              value={value(step.config, 'method')}
              onChange={(event) => set('method', event.target.value)}
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </label>
          {field('URL', 'url', { type: 'url' })}
          {field('Body (optional)', 'body', { multiline: true })}
          <p className="text-xs text-slate-500">
            Requests are stored only. Do not put credentials in this
            configuration.
          </p>
        </div>
      );
    case 'ai':
      return (
        <div className="space-y-3">
          <label className="block text-xs text-slate-400">
            Operation
            <select
              className={`${inputClass} mt-1`}
              value={value(step.config, 'operation')}
              onChange={(event) => set('operation', event.target.value)}
            >
              <option value="classify">Classify</option>
              <option value="extract">Extract</option>
            </select>
          </label>
          {field('Prompt', 'prompt', { multiline: true })}
          <p className="text-xs text-slate-500">
            Vendor neutral configuration; no AI request is made.
          </p>
        </div>
      );
    default:
      return null;
  }
}

export function WorkflowWorkspace({
  organizationId,
  onDirtyChange,
}: {
  organizationId: string;
  onDirtyChange?: (dirty: boolean, workflowName?: string) => void;
}) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = useState<WorkflowDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<TriggerType>('manual');
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(
    {},
  );
  const [steps, setSteps] = useState<WorkflowStepInput[]>([]);
  const [newName, setNewName] = useState('');
  const [newActionType, setNewActionType] = useState<ActionType>('log');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const draft = useMemo(
    () => ({ name, description, triggerType, triggerConfig, steps }),
    [name, description, triggerType, triggerConfig, steps],
  );
  const dirty = isWorkflowDraftDirty(selected, draft);

  useEffect(() => {
    onDirtyChange?.(dirty, selected?.name);
  }, [dirty, onDirtyChange, selected?.name]);
  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );
  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirty]);

  async function refresh() {
    const result = await api.workflows(organizationId);
    setWorkflows(result.workflows);
  }
  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice(message(error)));
  }, [organizationId]);
  function load(workflow: WorkflowDetail) {
    setSelected(workflow);
    setName(workflow.name);
    setDescription(workflow.description);
    setTriggerType(workflow.triggerType);
    setTriggerConfig(workflow.triggerConfig);
    setSteps(
      workflow.steps.map(
        ({ stepType, actionType, name, config, retryConfig }) => ({
          stepType,
          actionType,
          name,
          config,
          retryConfig,
        }),
      ),
    );
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try {
      await work();
      await refresh();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      selected &&
      !confirmDiscardChanges(
        dirty,
        selected.name,
        'Create and open a new workflow?',
        (prompt) => window.confirm(prompt),
      )
    )
      return;
    await perform(async () => {
      const input = createWorkflowInputSchema.parse({
        name: newName,
        description: '',
        triggerType: 'manual',
        triggerConfig: {},
      });
      const { workflow } = await api.createWorkflow(organizationId, input);
      setNewName('');
      load(workflow);
      setNotice('Draft created.');
    });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    await perform(async () => {
      const input = updateWorkflowInputSchema.parse({
        expectedVersion: selected.version,
        name,
        description,
        triggerType,
        triggerConfig,
        steps,
      });
      const { workflow } = await api.updateWorkflow(
        organizationId,
        selected.id,
        input,
      );
      load(workflow);
      setNotice('Workflow saved.');
    });
  }
  function replace(index: number, step: WorkflowStepInput) {
    setSteps((current) =>
      current.map((item, position) => (position === index ? step : item)),
    );
  }
  function move(index: number, direction: -1 | 1) {
    setSteps((current) => {
      const target = index + direction;
      if (
        target < 0 ||
        target >= current.length ||
        current[index]?.stepType !== current[target]?.stepType
      )
        return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }
  function setTriggerField(field: 'cron' | 'timezone', text: string) {
    setTriggerConfig((current) => {
      const next = { ...current };
      if (text.trim()) next[field] = text;
      else delete next[field];
      return next;
    });
  }
  async function status(workflow: WorkflowSummary, active: boolean) {
    const affectsOpenWorkflow = selected?.id === workflow.id;
    const activationMessage = activationGuardMessage(
      active && affectsOpenWorkflow && dirty,
    );
    if (activationMessage) {
      setNotice(activationMessage);
      return;
    }
    if (
      !active &&
      affectsOpenWorkflow &&
      !confirmDiscardChanges(
        dirty,
        selected.name,
        'Deactivate this workflow?',
        (prompt) => window.confirm(prompt),
      )
    )
      return;
    await perform(async () => {
      const result = active
        ? await api.activateWorkflow(organizationId, workflow.id)
        : await api.deactivateWorkflow(organizationId, workflow.id);
      if (selected?.id === workflow.id) load(result.workflow);
      setNotice(
        active
          ? 'Workflow activated. No execution was started.'
          : 'Workflow deactivated.',
      );
    });
  }
  async function remove(workflow: WorkflowSummary) {
    const deletingOpenWorkflow = selected?.id === workflow.id;
    const confirmed = deletingOpenWorkflow
      ? confirmDiscardChanges(
          dirty,
          selected.name,
          `Delete “${workflow.name}” permanently?`,
          (prompt) => window.confirm(prompt),
        ) &&
        (dirty || window.confirm(`Delete “${workflow.name}” permanently?`))
      : window.confirm(`Delete “${workflow.name}” permanently?`);
    if (!confirmed) return;
    await perform(async () => {
      await api.deleteWorkflow(organizationId, workflow.id);
      if (selected?.id === workflow.id) setSelected(null);
      setNotice('Workflow deleted.');
    });
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Workflows</h2>
          <p className="mt-1 text-sm text-slate-400">
            Configure automation now. Execution comes later.
          </p>
        </div>
        <span className="text-xs text-slate-500">
          {workflows.length} workflows
        </span>
      </div>
      {notice && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-cyan-800 bg-cyan-950/40 p-3 text-sm text-cyan-100"
        >
          {notice}
        </p>
      )}
      <form
        className="mt-6 flex flex-wrap gap-2"
        onSubmit={(event) => void create(event)}
      >
        <input
          aria-label="New workflow name"
          className={`${inputClass} min-w-48 flex-1`}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="New workflow name"
          required
          maxLength={120}
        />
        <button
          disabled={busy}
          className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          Create draft
        </button>
      </form>
      <div className="mt-6 space-y-2">
        {workflows.map((workflow) => (
          <div
            key={workflow.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-4"
          >
            <div>
              <button
                className="text-left font-medium text-cyan-300 hover:underline"
                onClick={() => {
                  if (
                    selected &&
                    !confirmDiscardChanges(
                      dirty,
                      selected.name,
                      selected.id === workflow.id
                        ? 'Reload this workflow?'
                        : 'Open another workflow?',
                      (prompt) => window.confirm(prompt),
                    )
                  )
                    return;
                  void perform(async () => {
                    load(
                      (await api.workflow(organizationId, workflow.id))
                        .workflow,
                    );
                  });
                }}
              >
                {workflow.name}
              </button>
              <p className="mt-1 text-xs text-slate-400">
                {workflow.status} · {workflow.triggerType} · v{workflow.version}{' '}
                · updated {new Date(workflow.updatedAt).toLocaleString()}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                disabled={busy}
                className={buttonClass}
                onClick={() =>
                  void status(workflow, workflow.status !== 'active')
                }
              >
                {workflow.status === 'active' ? 'Deactivate' : 'Activate'}
              </button>
              <button
                disabled={busy}
                className={`${buttonClass} text-rose-300`}
                onClick={() => void remove(workflow)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {workflows.length === 0 && (
          <p className="text-sm text-slate-400">
            No workflows yet. Create a draft to start.
          </p>
        )}
      </div>
      {selected && (
        <form
          className="mt-8 border-t border-slate-800 pt-7"
          onSubmit={(event) => void save(event)}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">Edit workflow</h3>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                if (
                  !confirmDiscardChanges(
                    dirty,
                    selected.name,
                    'Close the editor?',
                    (prompt) => window.confirm(prompt),
                  )
                )
                  return;
                setSelected(null);
              }}
            >
              Close
            </button>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Name
              <input
                className={`${inputClass} mt-1`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
              />
            </label>
            <label className="block text-xs text-slate-400">
              Trigger
              <select
                className={`${inputClass} mt-1`}
                value={triggerType}
                onChange={(event) => {
                  setTriggerType(event.target.value as TriggerType);
                  setTriggerConfig({});
                }}
              >
                <option value="manual">Manual</option>
                <option value="webhook">Webhook</option>
                <option value="schedule">Schedule</option>
              </select>
            </label>
            <label className="block text-xs text-slate-400 sm:col-span-2">
              Description
              <textarea
                className={`${inputClass} mt-1 min-h-20`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
              />
            </label>
          </div>
          {triggerType === 'schedule' && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block text-xs text-slate-400">
                Cron (five numeric fields)
                <input
                  className={`${inputClass} mt-1`}
                  value={value(triggerConfig, 'cron')}
                  onChange={(event) =>
                    setTriggerField('cron', event.target.value)
                  }
                  placeholder="0 9 * * 1-5"
                />
              </label>
              <label className="block text-xs text-slate-400">
                IANA timezone
                <input
                  className={`${inputClass} mt-1`}
                  value={value(triggerConfig, 'timezone')}
                  onChange={(event) =>
                    setTriggerField('timezone', event.target.value)
                  }
                  placeholder="UTC"
                />
              </label>
            </div>
          )}
          {triggerType === 'webhook' && (
            <p className="mt-4 text-xs text-slate-400">
              Webhook delivery is planned for a later phase.
            </p>
          )}
          {(['condition', 'action'] as const).map((type) => (
            <div key={type} className="mt-8">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="font-semibold capitalize">
                  {type === 'condition' ? 'Conditions' : 'Actions'}
                </h4>
                {type === 'condition' ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      setSteps((current) => [
                        ...current.filter(
                          (item) => item.stepType === 'condition',
                        ),
                        {
                          stepType: 'condition',
                          actionType: null,
                          name: 'Condition',
                          config: { field: '', operator: 'equals', value: '' },
                          retryConfig: {},
                        },
                        ...current.filter((item) => item.stepType === 'action'),
                      ])
                    }
                  >
                    Add condition
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <select
                      aria-label="New action type"
                      className={inputClass}
                      value={newActionType}
                      onChange={(event) =>
                        setNewActionType(event.target.value as ActionType)
                      }
                    >
                      {actionTypeSchema.options.map((action) => (
                        <option key={action} value={action}>
                          {action.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() =>
                        setSteps((current) => [
                          ...current,
                          newAction(newActionType),
                        ])
                      }
                    >
                      Add action
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-3 space-y-3">
                {steps.map(
                  (step, index) =>
                    step.stepType === type && (
                      <div
                        key={index}
                        className="rounded-lg border border-slate-800 bg-slate-950/60 p-4"
                      >
                        <div className="mb-4 flex flex-wrap items-center gap-2">
                          <span className="text-xs text-slate-500">
                            {index + 1}.
                          </span>
                          <input
                            aria-label="Step name"
                            className={`${inputClass} min-w-36 flex-1`}
                            value={step.name}
                            onChange={(event) =>
                              replace(index, {
                                ...step,
                                name: event.target.value,
                              })
                            }
                            maxLength={120}
                          />
                          <button
                            type="button"
                            aria-label="Move step up"
                            className={buttonClass}
                            onClick={() => move(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label="Move step down"
                            className={buttonClass}
                            onClick={() => move(index, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className={`${buttonClass} text-rose-300`}
                            onClick={() =>
                              setSteps((current) =>
                                current.filter(
                                  (_, position) => position !== index,
                                ),
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                        <StepFields
                          step={step}
                          change={(next) => replace(index, next)}
                        />
                      </div>
                    ),
                )}
              </div>
            </div>
          ))}
          <div className="mt-8 flex items-center gap-3">
            <button
              disabled={busy}
              className="rounded-lg bg-cyan-500 px-5 py-2 font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              Save configuration
            </button>
            <span className="text-xs text-slate-400">
              Save before activating. Configuration changes increment the
              version.
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
