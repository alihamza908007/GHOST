'use client';

import React from 'react';
import { Clock } from 'lucide-react';
import type { TaskEvent } from '../lib/types';
import { Card } from './ui/Card';

interface TimelineProps {
  events: TaskEvent[];
}

function eventSummary(event: TaskEvent): { title: string; detail?: string; tone: string } {
  const data = event.data ?? {};
  const detailValue =
    (typeof data.message === 'string' && data.message) ||
    (typeof data.detail === 'string' && data.detail) ||
    (typeof data.reason === 'string' && data.reason) ||
    (typeof data.code === 'string' && data.code) ||
    (typeof data.objectiveSummary === 'string' && data.objectiveSummary) ||
    '';

  switch (event.type) {
    case 'TASK_CREATED':
      return { title: 'Task created', detail: detailValue, tone: 'text-zinc-400' };
    case 'PLANNING_STARTED':
      return {
        title: 'Planning started',
        detail: typeof data.model === 'string' ? `Model: ${data.model}` : undefined,
        tone: 'text-blue-400',
      };
    case 'PLANNING_COMPLETED':
      return {
        title: 'Planning completed',
        detail:
          typeof data.latencyMs === 'number'
            ? `${data.stepCount ?? '?'} steps · ${data.attempts ?? 1} attempt(s) · ${data.latencyMs}ms`
            : undefined,
        tone: 'text-green-400',
      };
    case 'PLAN_READY':
      return {
        title: 'Plan ready',
        detail:
          typeof data.stepCount === 'number'
            ? `${data.stepCount} validated step(s)`
            : detailValue,
        tone: 'text-green-400',
      };
    case 'PLAN_VALIDATION_FAILED':
      return { title: 'Plan rejected before execution', detail: detailValue, tone: 'text-red-400' };
    case 'MODEL_ERROR':
      return { title: 'Planner model unavailable', detail: detailValue, tone: 'text-red-400' };
    case 'ACTION_STARTED':
      return {
        title: `Action ${typeof data.stepIndex === 'number' ? data.stepIndex + 1 : ''}: ${
          data.actionType ?? 'action'
        }`,
        detail: typeof data.description === 'string' ? data.description : undefined,
        tone: 'text-blue-400',
      };
    case 'ACTION_FINISHED':
      return {
        title: `Action finished: ${data.actionType ?? 'action'}`,
        detail: typeof data.screenshot === 'string' ? 'Screenshot evidence captured' : undefined,
        tone: 'text-zinc-400',
      };
    case 'VERIFICATION_RESULT':
      return {
        title: `Verification ${String(data.outcome ?? '')}`,
        detail: [data.method, data.detail].filter(Boolean).join(': '),
        tone:
          data.outcome === 'passed'
            ? 'text-green-400'
            : data.outcome === 'inconclusive'
              ? 'text-amber-300'
              : 'text-red-400',
      };
    case 'POLICY_REJECTION':
      return { title: 'Policy rejection', detail: detailValue, tone: 'text-red-400' };
    case 'APPROVAL_REQUIRED':
      return {
        title: 'Human approval required',
        detail: `${data.actionType ?? 'action'} at step ${
          typeof data.stepIndex === 'number' ? data.stepIndex + 1 : '?'
        }`,
        tone: 'text-amber-300',
      };
    case 'APPROVAL_GRANTED':
      return { title: 'Action approved', detail: detailValue, tone: 'text-green-400' };
    case 'APPROVAL_REJECTED':
      return { title: 'Action rejected', detail: detailValue, tone: 'text-red-400' };
    case 'VISUAL_OBSERVATION_STARTED':
      return {
        title: 'Visual observation started',
        detail: `Checking expected condition: ${String(data.expectedCondition ?? 'present')}`,
        tone: 'text-blue-400',
      };
    case 'VISUAL_OBSERVATION_COMPLETED':
      return {
        title: 'Visual observation complete',
        detail: [
          typeof data.summary === 'string' ? data.summary : undefined,
          typeof data.expectedCondition === 'string' ? `expected: ${data.expectedCondition}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        tone: data.available === false ? 'text-amber-300' : 'text-green-400',
      };
    case 'VISUAL_UNAVAILABLE':
      return {
        title: 'Visual observation unavailable',
        detail: typeof data.reason === 'string' ? data.reason : 'Local vision model did not produce evidence',
        tone: 'text-amber-300',
      };
    case 'DOM_VISUAL_DISAGREEMENT':
      return {
        title: 'Deterministic and visual checks disagreed',
        detail: [
          typeof data.deterministicOutcome === 'string' ? `deterministic: ${data.deterministicOutcome}` : undefined,
          typeof data.visualSummary === 'string' ? `visual: ${data.visualSummary}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        tone: 'text-amber-300',
      };
    case 'RECOVERY_STARTED':
      return {
        title: 'Bounded recovery started',
        detail: `Recovery attempt ${String(data.recoveryAttempt ?? '')}${
          typeof data.stepIndex === 'number' ? ` at step ${data.stepIndex + 1}` : ''
        }`,
        tone: 'text-amber-300',
      };
    case 'RECOVERY_COMPLETED':
      return { title: 'Bounded recovery completed', detail: detailValue, tone: 'text-green-400' };
    case 'RETRY_AUTHORIZED':
      return {
        title: 'Retry authorized by recovery policy',
        detail: detailValue,
        tone: 'text-blue-400',
      };
    case 'RETRY_REJECTED':
      return { title: 'Retry rejected', detail: detailValue, tone: 'text-red-400' };
    case 'RECOVERY_BUDGET_EXHAUSTED':
      return {
        title: 'Recovery budget exhausted',
        detail: detailValue,
        tone: 'text-red-400',
      };
    case 'ORIGIN_TRANSITION':
      return {
        title: 'Origin transition',
        detail: `${String(data.from ?? '')} → ${String(data.to ?? '')}${
          data.authorized === false ? ' (rejected)' : ''
        }`,
        tone: data.authorized === false ? 'text-red-400' : 'text-blue-400',
      };
    case 'TASK_CANCELLED':
      return { title: 'Task cancelled', detail: detailValue, tone: 'text-zinc-400' };
    case 'TASK_COMPLETED':
      return { title: 'Task completed', detail: detailValue, tone: 'text-green-400' };
    case 'TASK_INTERRUPTED':
      return { title: 'Task interrupted by restart', detail: detailValue, tone: 'text-amber-300' };
    case 'ERROR':
      return { title: 'Error', detail: detailValue, tone: 'text-red-400' };
    default:
      return { title: event.type.replaceAll('_', ' '), detail: detailValue, tone: 'text-zinc-400' };
  }
}

export function Timeline({ events }: TimelineProps) {
  return (
    <Card
      header={
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <Clock className="h-4 w-4 text-zinc-500" />
          Event timeline
        </div>
      }
    >
      <div className="space-y-3 max-h-[420px] overflow-auto pr-1">
        {events.length === 0 && <p className="text-sm text-zinc-600">No events recorded yet.</p>}
        {events.map((event) => {
          const summary = eventSummary(event);
          return (
            <div key={event.id} className="flex gap-3 text-sm">
              <div className="w-1.5 h-1.5 rounded-full bg-zinc-700 mt-2 shrink-0" />
              <div className="min-w-0">
                <p className={`${summary.tone} text-[13px]`}>{summary.title}</p>
                {summary.detail && (
                  <p className="text-zinc-600 text-[11px] mt-0.5 break-words">{summary.detail}</p>
                )}
                <p className="text-zinc-700 text-[10px]">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
