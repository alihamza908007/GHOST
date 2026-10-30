'use client';

import React, { useState } from 'react';
import { Ban, Cpu, RotateCcw, Save } from 'lucide-react';
import type { Plan, Task, TaskEvent } from '../lib/types';
import { Card } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Input';
import { ApprovalPanel } from './ApprovalPanel';
import { PlanView } from './PlanView';
import { Timeline } from './Timeline';
import { EvidenceView } from './EvidenceView';
import { ResearchView } from './ResearchView';

interface TaskDetailProps {
  task: Task;
  events: TaskEvent[];
  screenshotUrl: string | null;
  onCancel: () => Promise<void>;
  onApprove: (decision: 'approve' | 'reject') => Promise<void>;
  onSaveSkill: (name: string) => Promise<{ inputs: string[] }>;
  onRetry: () => Promise<void>;
}

const STAGES = ['PLANNING', 'PLAN_READY', 'EXECUTING', 'VERIFYING', 'COMPLETED'];

function statusTone(status: string): 'green' | 'red' | 'amber' | 'blue' | 'neutral' {
  if (status === 'COMPLETED') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'CANCELLED') return 'neutral';
  if (status === 'AWAITING_APPROVAL' || status === 'RETRYING') return 'amber';
  return 'blue';
}

function stageIndex(status: string): number {
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) return STAGES.length - 1;
  return Math.max(0, STAGES.indexOf(status));
}

export function TaskDetail({
  task,
  events,
  screenshotUrl,
  onCancel,
  onApprove,
  onSaveSkill,
  onRetry,
}: TaskDetailProps) {
  const [skillName, setSkillName] = useState('');
  const [savingSkill, setSavingSkill] = useState(false);
  const [savedSkill, setSavedSkill] = useState<{ inputs: string[] } | null>(null);

  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status);
  const current = stageIndex(task.status);
  const totalSteps = task.plan?.steps.length ?? 0;
  const stepNumber = Math.min(task.currentStepIndex + 1, Math.max(totalSteps, 1));

  const save = async () => {
    if (!skillName.trim()) return;
    setSavingSkill(true);
    setSavedSkill(null);
    try {
      const result = await onSaveSkill(skillName.trim());
      setSavedSkill(result);
      setSkillName('');
    } finally {
      setSavingSkill(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(task.status)}>{task.status.replaceAll('_', ' ')}</Badge>
              {totalSteps > 0 && (
                <span className="text-xs text-zinc-500">
                  Step {stepNumber} / {totalSteps}
                </span>
              )}
              {task.plannerModel && (
                <span className="inline-flex items-center gap-1 text-[10px] text-zinc-600">
                  <Cpu className="h-3 w-3" />
                  {task.plannerModel}
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-200">{task.objective}</p>
            {task.planSummary && <p className="text-xs text-zinc-500">{task.planSummary}</p>}
            {task.approvedOrigins && task.approvedOrigins.length > 0 && (
              <p className="text-[11px] text-zinc-600">
                Approved origins: {task.approvedOrigins.join(', ')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!terminal && (
              <Button variant="secondary" size="sm" onClick={() => void onCancel()} icon={<Ban className="h-3.5 w-3.5" />}>
                Cancel
              </Button>
            )}
            {terminal && task.status !== 'COMPLETED' && (
              <Button variant="secondary" size="sm" onClick={() => void onRetry()} icon={<RotateCcw className="h-3.5 w-3.5" />}>
                Retry
              </Button>
            )}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-5 gap-2">
          {STAGES.map((stage, index) => {
            const active = index <= current;
            const isCurrent = index === current && !terminal;
            return (
              <div key={stage} className="text-center">
                <div className={`h-1.5 rounded-full mb-2 ${active ? 'bg-blue-500' : 'bg-zinc-800'}`} />
                <span
                  className={`text-[10px] uppercase tracking-wide ${
                    isCurrent ? 'text-blue-300' : active ? 'text-zinc-400' : 'text-zinc-700'
                  }`}
                >
                  {stage.replaceAll('_', ' ')}
                </span>
              </div>
            );
          })}
        </div>

        {task.error && (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {task.error}
          </div>
        )}

        {!terminal && task.status !== 'AWAITING_APPROVAL' && (
          <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
            <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
            Running…
          </div>
        )}
      </Card>

      {task.pendingApproval && (
        <ApprovalPanel approval={task.pendingApproval} onDecide={onApprove} />
      )}

      {task.researchResultJson && <ResearchView task={task} />}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <PlanView plan={task.plan as Plan | null} currentStepIndex={task.currentStepIndex} status={task.status} />
        <Timeline events={events} />
      </div>

      <EvidenceView screenshotUrl={screenshotUrl} status={task.status} />

      {task.status === 'COMPLETED' && task.plan && (
        <Card
          header={
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <Save className="h-4 w-4 text-zinc-500" />
              Save as reusable skill
            </div>
          }
        >
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <Field label="Skill name" className="flex-1">
              <Input
                value={skillName}
                onChange={(event) => setSkillName(event.target.value)}
                placeholder="Sign in to the demo application"
              />
            </Field>
            <Button loading={savingSkill} disabled={!skillName.trim()} onClick={() => void save()}>
              Save skill
            </Button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2">
            Converts verified actions into parameterized steps. Fill values become inputs such as{' '}
            <code className="text-zinc-400">{'{{email}}'}</code>.
          </p>
          {savedSkill && (
            <p className="text-[11px] text-green-300/90 mt-2">
              Saved with {savedSkill.inputs.length} detected input{savedSkill.inputs.length === 1 ? '' : 's'}
              {savedSkill.inputs.length > 0 ? `: ${savedSkill.inputs.join(', ')}` : '.'}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
