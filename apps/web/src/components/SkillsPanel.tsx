'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Play, Plus, Terminal, Trash2, History, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { Skill, SkillDefinition, SkillInputSpec, SkillRun } from '../lib/types';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Field, Input, Textarea } from './ui/Input';
import { Badge } from './ui/Badge';

interface SkillsPanelProps {
  onSelectTask: (taskId: string) => void;
  onError: (message: string) => void;
}

const ACTION_TYPES = ['NAVIGATE', 'CLICK', 'FILL', 'SCREENSHOT'] as const;
type ActionType = (typeof ACTION_TYPES)[number];

interface StepDraft {
  key: number;
  actionType: ActionType;
  description: string;
  url?: string;
  expectText?: string;
  locatorBy?: 'role' | 'label' | 'testId';
  locatorRole?: string;
  locatorName?: string;
  locatorLabel?: string;
  locatorTestId?: string;
  fillValue?: string;
  shotName?: string;
}

interface SavedSkillResult {
  id: string;
}

let stepKey = 0;
const newStep = (actionType: ActionType = 'NAVIGATE'): StepDraft => ({
  key: ++stepKey,
  actionType,
  description: actionType === 'SCREENSHOT' ? 'Capture screenshot' : actionType === 'NAVIGATE' ? 'Navigate' : 'Perform action',
  url: actionType === 'NAVIGATE' ? 'http://127.0.0.1:3001' : undefined,
  expectText: actionType === 'NAVIGATE' ? 'GHOST Demo Application' : '',
  locatorBy: actionType === 'FILL' ? 'label' : actionType === 'CLICK' ? 'label' : undefined,
  locatorRole: 'button',
  locatorName: '',
  locatorLabel: '',
  locatorTestId: '',
  fillValue: actionType === 'FILL' ? '{{email}}' : '',
  shotName: actionType === 'SCREENSHOT' ? 'result' : 'result',
});

export function SkillsPanel({ onSelectTask, onError }: SkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [inputs, setInputs] = useState<SkillInputSpec[]>([]);
  const [steps, setSteps] = useState<StepDraft[]>([newStep()]);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);
  const [runs, setRuns] = useState<SkillRun[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getSkills();
      setSkills(res.skills);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to load skills.');
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadRuns = useCallback(
    async (skill: Skill) => {
      setActiveSkill(skill);
      try {
        const res = await api.getSkillRuns(skill.id);
        setRuns(res.runs);
      } catch {
        setRuns([]);
      }
    },
    []
  );

  const addInput = () => {
    setInputs((prev) => [...prev, { name: '', type: 'string', description: '', required: true }]);
  };

  const updateInput = (index: number, patch: Partial<SkillInputSpec>) => {
    setInputs((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeInput = (index: number) => {
    setInputs((prev) => prev.filter((_, i) => i !== index));
  };

  const addStep = (actionType: ActionType = 'FILL') => {
    setSteps((prev) => [...prev, newStep(actionType)]);
  };

  const updateStep = (key: number, patch: Partial<StepDraft>) => {
    setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  };

  const removeStep = (key: number) => {
    setSteps((prev) => prev.filter((step) => step.key !== key));
  };

  const buildDefinition = (): { definition?: SkillDefinition; error?: string } => {
    const trimmedName = name.trim();
    if (!trimmedName) return { error: 'Skill name is required.' };
    const usedInputs = new Set<string>();
    const validatedInputs: SkillInputSpec[] = [];
    for (const input of inputs) {
      const inputName = input.name.trim();
      if (!inputName) return { error: 'Every input needs a name.' };
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(inputName)) {
        return { error: `Input "${inputName}" has an invalid name.` };
      }
      if (usedInputs.has(inputName)) return { error: `Input "${inputName}" is declared twice.` };
      usedInputs.add(inputName);
      validatedInputs.push({
        name: inputName,
        type: input.type,
        required: input.required !== false,
        description: input.description?.trim() || undefined,
        maxLength: 500,
      });
    }

    const builtSteps: Array<Record<string, unknown>> = [];
    for (const draft of steps) {
      if (draft.actionType === 'NAVIGATE') {
        const url = (draft.url ?? '').trim();
        if (!/^https?:\/\/.+\..+/.test(url)) return { error: 'Step requires a valid http(s) URL.' };
        builtSteps.push({
          action: { type: 'NAVIGATE', payload: { url } },
          description: draft.description.trim() || 'Navigate',
          expectation: { kind: 'url', value: url },
        });
        continue;
      }
      if (draft.actionType === 'SCREENSHOT') {
        const shotName = draft.shotName?.trim() || 'result';
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(shotName)) return { error: 'Screenshot name must be a safe slug.' };
        builtSteps.push({
          action: { type: 'SCREENSHOT', payload: { name: shotName } },
          description: draft.description.trim() || 'Capture screenshot',
          expectation: { kind: 'screenshot' },
        });
        continue;
      }
      const locatorBy = draft.locatorBy;
      const locator =
        locatorBy === 'role'
          ? { by: 'role', role: draft.locatorRole as 'button', name: draft.locatorName?.trim() ?? '' }
          : locatorBy === 'testId'
            ? { by: 'testId', testId: draft.locatorTestId?.trim() ?? '' }
            : { by: 'label', label: draft.locatorLabel?.trim() ?? '' };
      const locatorFieldKey = Object.keys(locator).find((key) => key !== 'by');
      const locatorFieldValue = locatorFieldKey ? String((locator as Record<string, unknown>)[locatorFieldKey]) : '';
      if (!locator || !locatorFieldKey || locatorFieldValue.trim() === '') {
        return { error: `Step "${draft.description || draft.actionType}" needs a locator.` };
      }
      const base: Record<string, unknown> =
        draft.actionType === 'FILL'
          ? {
              type: 'FILL',
              payload: { locator, value: draft.fillValue?.trim() || '{{value}}' },
            }
          : { type: 'CLICK', payload: { locator } };
      const expectation: Record<string, unknown> =
        draft.actionType === 'FILL'
          ? { kind: 'fieldValue', locator }
          : { kind: 'visibleText', value: (draft.expectText ?? '').trim() };
      builtSteps.push({ ...base, description: draft.description.trim() || 'Perform action', expectation });
    }

    const definition: SkillDefinition = {
      name: trimmedName,
      description: description.trim() || undefined,
      inputs: validatedInputs,
      steps: builtSteps as unknown as SkillDefinition['steps'],
    };
    return { definition };
  };

  const createSkill = async () => {
    const built = buildDefinition();
    if (built.error || !built.definition) {
      onError(built.error ?? 'Unable to build the skill definition.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.saveSkill(built.definition.name, built.definition);
      setCreating(false);
      setName('');
      setDescription('');
      setInputs([]);
      setSteps([newStep()]);
      await refresh();
      onError(`Saved skill "${built.definition.name}".`);
      return res;
    } catch (error) {
      return;
    } finally {
      setCreating(false);
    }
  };

  const runSkill = async (skill: Skill) => {
    const payload: Record<string, unknown> = {};
    const specs = skill.definition.inputs ?? [];
    for (const spec of specs) {
      const raw = runInputs[spec.name] ?? '';
      if (spec.required !== false && raw === '') {
        onError(`Input "${spec.name}" is required.`);
        return;
      }
      payload[spec.name] = spec.type === 'number' ? Number(raw) : raw;
    }
    try {
      const res = await api.runSkill(skill.id, payload);
      onSelectTask(res.taskId);
      await loadRuns(skill);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unable to run skill.');
    }
  };

  const activeInputs = useMemo(() => activeSkill?.definition.inputs ?? [], [activeSkill]);

  return (
    <div className="space-y-6">
      <Card>
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <BookOpen className="h-4 w-4 text-zinc-500" />
            Saved skills
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw className="h-3 w-3" />}
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              Refresh
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCreating((prev) => !prev)} icon={<Plus className="h-3 w-3" />}>
              New skill
            </Button>
          </div>
        </div>
        <div className="p-5">
          {creating && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Name">
                  <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Sign in to the demo" />
                </Field>
                <Field label="Description" hint="Optional summary shown in the skill list.">
                  <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Fills the sign-in form" />
                </Field>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] uppercase tracking-wider text-zinc-500">Inputs</span>
                  <Button size="sm" variant="ghost" onClick={addInput} icon={<Plus className="h-3 w-3" />}>
                    Add input
                  </Button>
                </div>
                <div className="space-y-2">
                  {inputs.length === 0 && <p className="text-[11px] text-zinc-600">No inputs yet. Add parameters used with &lbrace;&lbrace;name&rbrace;&rbrace; placeholders.</p>}
                  {inputs.map((input, index) => (
                    <div key={index} className="grid grid-cols-[1fr_90px] gap-2 sm:grid-cols-[1fr_90px_36px]">
                      <Input
                        value={input.name}
                        onChange={(event) => updateInput(index, { name: event.target.value })}
                        placeholder="email"
                        aria-label={`Input ${index + 1} name`}
                      />
                      <select
                        value={input.type}
                        onChange={(event) => updateInput(index, { type: event.target.value as 'string' | 'number' })}
                        className="bg-[#0a0a0a] border border-zinc-800 rounded-xl px-2 text-xs text-zinc-200"
                        aria-label={`Input ${index + 1} type`}
                      >
                        <option value="string">string</option>
                        <option value="number">number</option>
                      </select>
                      <Button size="sm" variant="ghost" onClick={() => removeInput(index)} icon={<Trash2 className="h-3 w-3" />} aria-label={`Remove input ${index + 1}`} />
                      <label className="flex items-center gap-2 text-[11px] text-zinc-400 sm:col-span-2 sm:col-start-1 sm:row-start-2">
                        <input
                          type="checkbox"
                          checked={input.required !== false}
                          onChange={(event) => updateInput(index, { required: event.target.checked })}
                          className="accent-zinc-200"
                        />
                        Required
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] uppercase tracking-wider text-zinc-500">Steps</span>
                  <div className="flex gap-2">
                    {ACTION_TYPES.map((actionType) => (
                      <Button key={actionType} size="sm" variant="ghost" onClick={() => addStep(actionType)} icon={<Plus className="h-3 w-3" />}>
                        {actionType}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  {steps.map((draft, index) => (
                    <div key={draft.key} className="rounded-xl border border-zinc-800 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-600">Step {index + 1}</span>
                        <select
                          value={draft.actionType}
                          onChange={(event) => updateStep(draft.key, { actionType: event.target.value as ActionType })}
                          className="bg-[#0a0a0a] border border-zinc-800 rounded-lg px-2 text-xs text-zinc-200"
                          aria-label={`Step ${index + 1} action type`}
                        >
                          {ACTION_TYPES.map((actionType) => (
                            <option key={actionType} value={actionType}>
                              {actionType}
                            </option>
                          ))}
                        </select>
                        <Input
                          value={draft.description}
                          onChange={(event) => updateStep(draft.key, { description: event.target.value })}
                          placeholder="What does this step do?"
                          aria-label={`Step ${index + 1} description`}
                        />
                        <Button size="sm" variant="ghost" onClick={() => removeStep(draft.key)} icon={<Trash2 className="h-3 w-3" />} aria-label={`Remove step ${index + 1}`} />
                      </div>

                      {draft.actionType === 'NAVIGATE' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <Input value={draft.url ?? ''} onChange={(event) => updateStep(draft.key, { url: event.target.value })} placeholder="http://127.0.0.1:3001" aria-label={`Step ${index + 1} url`} />
                          <Input value={draft.expectText ?? ''} onChange={(event) => updateStep(draft.key, { expectText: event.target.value })} placeholder="Expected page text" aria-label={`Step ${index + 1} expected text`} />
                        </div>
                      )}

                      {(draft.actionType === 'CLICK' || draft.actionType === 'FILL') && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <select
                            value={draft.locatorBy}
                            onChange={(event) => updateStep(draft.key, { locatorBy: event.target.value as StepDraft['locatorBy'] })}
                            className="bg-[#0a0a0a] border border-zinc-800 rounded-xl px-2 text-xs text-zinc-200"
                            aria-label={`Step ${index + 1} locator kind`}
                          >
                            <option value="label">label</option>
                            <option value="role">role</option>
                            <option value="testId">testId</option>
                          </select>
                          {draft.locatorBy === 'role' && (
                            <>
                              <select
                                value={draft.locatorRole ?? 'button'}
                                onChange={(event) => updateStep(draft.key, { locatorRole: event.target.value })}
                                className="bg-[#0a0a0a] border border-zinc-800 rounded-xl px-2 text-xs text-zinc-200"
                                aria-label={`Step ${index + 1} role`}
                              >
                                <option value="button">button</option>
                                <option value="link">link</option>
                                <option value="textbox">textbox</option>
                                <option value="checkbox">checkbox</option>
                                <option value="combobox">combobox</option>
                                <option value="heading">heading</option>
                                <option value="menuitem">menuitem</option>
                                <option value="tab">tab</option>
                              </select>
                              <Input value={draft.locatorName ?? ''} onChange={(event) => updateStep(draft.key, { locatorName: event.target.value })} placeholder="Element name" aria-label={`Step ${index + 1} element name`} />
                            </>
                          )}
                          {draft.locatorBy === 'label' && (
                            <Input value={draft.locatorLabel ?? ''} onChange={(event) => updateStep(draft.key, { locatorLabel: event.target.value })} placeholder="Field label, e.g. Email" aria-label={`Step ${index + 1} locator label`} />
                          )}
                          {draft.locatorBy === 'testId' && (
                            <Input value={draft.locatorTestId ?? ''} onChange={(event) => updateStep(draft.key, { locatorTestId: event.target.value })} placeholder="Test id, e.g. email-field" aria-label={`Step ${index + 1} test id`} />
                          )}
                          {draft.actionType === 'FILL' && (
                            <Input value={draft.fillValue ?? ''} onChange={(event) => updateStep(draft.key, { fillValue: event.target.value })} placeholder="Value or {{inputName}}" aria-label={`Step ${index + 1} fill value`} />
                          )}
                          {draft.actionType === 'CLICK' && (
                            <Input value={draft.expectText ?? ''} onChange={(event) => updateStep(draft.key, { expectText: event.target.value })} placeholder="Expected outcome text" aria-label={`Step ${index + 1} expected text`} />
                          )}
                        </div>
                      )}

                      {draft.actionType === 'SCREENSHOT' && (
                        <Input value={draft.shotName ?? ''} onChange={(event) => updateStep(draft.key, { shotName: event.target.value })} placeholder="Screenshot name" aria-label={`Step ${index + 1} screenshot name`} />
                      )}
                    </div>
                  ))}
                </div>
                <Button size="sm" variant="secondary" onClick={() => addStep('FILL')} icon={<Plus className="h-3 w-3" />}>
                  Add step
                </Button>
              </div>

              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void createSkill()}>
                  Save skill
                </Button>
              </div>
            </div>
          )}
          {!creating && loading && <p className="text-sm text-zinc-600">Loading skills…</p>}
          {!creating && !loading && skills.length === 0 && (
            <p className="text-sm text-zinc-600">No skills saved yet. Create one or save a completed task to auto-parameterize it.</p>
          )}
          {!creating && !loading && skills.length > 0 && (
            <div className="space-y-2">
              {skills.map((skill) => (
                <div key={skill.id} className="rounded-xl border border-zinc-800 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 truncate">{skill.name}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">
                        {skill.definition.description || `${skill.definition.steps?.length ?? 0} steps`}
                        {(skill.definition.inputs ?? []).length > 0 &&
                          ` · ${(skill.definition.inputs ?? []).length} input(s)`}
                      </p>
                    </div>
                    <Badge tone="neutral">v{skill.version}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-3">
                    <Button size="sm" variant="ghost" onClick={() => void loadRuns(skill)} icon={<History className="h-3 w-3" />}>
                      Runs
                    </Button>
                    <Button size="sm" onClick={() => void runSkill(skill)} icon={<Play className="h-3 w-3" />}>
                      Run
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="space-y-6">
          {activeSkill ? (
            <Card
              header={
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                    <Terminal className="h-4 w-4 text-zinc-500" />
                    Run {activeSkill.name}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setActiveSkill(null)}>
                    Close
                  </Button>
                </div>
              }
            >
              <div className="space-y-4">
                {(activeInputs ?? []).length === 0 && <p className="text-sm text-zinc-600">This skill takes no inputs.</p>}
                {(activeInputs ?? []).map((input) => (
                  <Field key={input.name} label={input.name} hint={input.description}>
                    <Input
                      value={runInputs[input.name] ?? ''}
                      onChange={(event) => setRunInputs((prev) => ({ ...prev, [input.name]: event.target.value }))}
                      placeholder={input.type === 'number' ? '0' : 'Value'}
                    />
                  </Field>
                ))}
                <Button onClick={() => void runSkill(activeSkill)} icon={<Play className="h-4 w-4" />}>
                  Execute skill
                </Button>
              </div>
            </Card>
          ) : (
            <Card>
              <div className="p-5">
                <div className="rounded-2xl bg-[#0d0d0d] border border-zinc-800 p-5">
                  <h3 className="text-sm font-medium text-zinc-200">Run a saved skill</h3>
                  <p className="text-xs text-zinc-500 mt-1">
                    Saved skills execute through the same policy-gated engine. Run inputs with <code className="text-zinc-400">{'{{name}}'}</code>{' '}
                    placeholders flow into validated steps.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-4">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Play className="h-3 w-3" />}
                      onClick={() => {
                        const first = skills[0];
                        if (first) void runSkill(first);
                      }}
                    >
                      Run latest
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void refresh()}>
                      Browse skills
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {activeSkill && (
            <Card
              header={
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <History className="h-4 w-4 text-zinc-500" />
                  Run history
                </div>
              }
            >
              {runs.length === 0 && <p className="text-sm text-zinc-600">No runs recorded for this skill.</p>}
              <div className="space-y-2">
                {runs.map((run) => (
                  <div key={run.id} className="flex items-center justify-between gap-2 text-xs border border-zinc-800 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-zinc-300">{new Date(run.startedAt).toLocaleString()}</p>
                      <p className="text-[10px] text-zinc-600">{JSON.stringify(run.inputs)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={run.status === 'COMPLETED' ? 'green' : run.status === 'FAILED' ? 'red' : 'blue'}>{run.status}</Badge>
                      {run.taskId && (
                        <Button size="sm" variant="ghost" onClick={() => onSelectTask(run.taskId!)}>
                          Open
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
