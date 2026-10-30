'use client';

import React from 'react';
import { CheckCircle2, Circle, ListChecks } from 'lucide-react';
import type { Plan } from '../lib/types';
import { Card } from './ui/Card';
import { Badge } from './ui/Badge';

interface PlanViewProps {
  plan: Plan | null;
  currentStepIndex: number;
  status: string;
}

export function PlanView({ plan, currentStepIndex, status }: PlanViewProps) {
  const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);
  return (
    <Card
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <ListChecks className="h-4 w-4 text-zinc-500" />
            Generated plan
          </div>
          {plan && <Badge tone="neutral">{plan.steps.length} steps</Badge>}
        </div>
      }
    >
      {!plan && (
        <p className="text-sm text-zinc-600 py-4 text-center">Waiting for a validated plan…</p>
      )}
      {plan && (
        <ol className="space-y-3">
          {plan.steps.map((step, index) => {
            const done = index < currentStepIndex || status === 'COMPLETED';
            const current = index === currentStepIndex && !isTerminal;
            return (
              <li
                key={index}
                className={`rounded-xl border p-3 transition-colors ${
                  current
                    ? 'border-blue-500/40 bg-blue-500/5'
                    : done
                      ? 'border-zinc-800 bg-[#0d0d0d]'
                      : 'border-zinc-800'
                }`}
              >
                <div className="flex items-start gap-2">
                  {done ? (
                    <CheckCircle2 className="h-4 w-4 text-green-400 mt-0.5 shrink-0" />
                  ) : (
                    <Circle className={`h-4 w-4 mt-0.5 shrink-0 ${current ? 'text-blue-400' : 'text-zinc-700'}`} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-blue-300">
                        {step.action.type}
                      </span>
                      <span className="text-[10px] text-zinc-600">
                        {done ? 'done' : current ? 'active' : 'pending'}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-300 mt-0.5">{step.description}</p>
                    <p className="text-[11px] text-zinc-600 mt-1">
                      Verify: {step.expectation.kind}
                      {step.expectation.value ? ` · ${step.expectation.value}` : ''}
                    </p>
                    {step.rationale && (
                      <p className="text-[11px] text-zinc-500 mt-1 italic">{step.rationale}</p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {plan.rationale && (
            <li className="text-[11px] text-zinc-500 italic border-t border-zinc-800 pt-3">
              {plan.rationale}
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}
