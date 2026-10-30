'use client';

import React from 'react';
import { History } from 'lucide-react';
import type { Task } from '../lib/types';
import { Card } from './ui/Card';
import { Badge } from './ui/Badge';

interface TaskHistoryProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function statusTone(status: string): 'green' | 'red' | 'amber' | 'blue' | 'neutral' {
  if (status === 'COMPLETED') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'CANCELLED') return 'neutral';
  if (status === 'AWAITING_APPROVAL' || status === 'RETRYING') return 'amber';
  return 'blue';
}

export function TaskHistory({ tasks, selectedId, onSelect }: TaskHistoryProps) {
  return (
    <Card padding="none">
      <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <History className="h-4 w-4 text-zinc-500" />
          Task history
        </div>
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Persisted</span>
      </div>
      <div className="max-h-[360px] overflow-auto divide-y divide-zinc-800/70">
        {tasks.length === 0 && (
          <p className="px-5 py-6 text-sm text-zinc-600">No tasks yet. Start your first objective.</p>
        )}
        {tasks.map((task) => (
          <button
            key={task.id}
            onClick={() => onSelect(task.id)}
            className={`w-full text-left px-5 py-3 transition-colors ${
              selectedId === task.id ? 'bg-zinc-800/50' : 'hover:bg-zinc-900/60'
            }`}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <Badge tone={statusTone(task.status)}>{task.status.replaceAll('_', ' ')}</Badge>
              <span className="text-[10px] text-zinc-600">
                {task.createdAt ? new Date(task.createdAt).toLocaleTimeString() : ''}
              </span>
            </div>
            <p className="text-xs text-zinc-300 line-clamp-2">{task.planSummary || task.objective}</p>
          </button>
        ))}
      </div>
    </Card>
  );
}
