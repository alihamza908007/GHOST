'use client';

import React, { useState } from 'react';
import { Play, Shield, Globe } from 'lucide-react';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Field, Input, Textarea } from './ui/Input';

interface TaskComposerProps {
  onStart: (objective: string, origins: string[]) => Promise<void>;
  loading: boolean;
  defaultOrigins?: string;
}

const EXAMPLES = [
  'Open the GHOST demo application and capture a screenshot.',
  'Fill the Email field with demo@example.com, click Sign in, and capture a screenshot.',
  'Show the message on the demo page, then capture a screenshot.',
];

export function TaskComposer({ onStart, loading, defaultOrigins = '' }: TaskComposerProps) {
  const [objective, setObjective] = useState(
    'Open the GHOST demo application, fill the Email field with demo@example.com, click Sign in, and capture a screenshot.'
  );
  const [origins, setOrigins] = useState(defaultOrigins);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = objective.trim();
    if (!trimmed) {
      setError('Enter an objective to run.');
      return;
    }
    const parsedOrigins = origins
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      await onStart(trimmed, parsedOrigins);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Unable to start the task.');
    }
  };

  return (
    <Card
      header={
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-zinc-200">New task</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">Describe the outcome; GHOST plans and verifies every step.</p>
          </div>
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Composer</span>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Objective">
          <Textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            rows={4}
            maxLength={1000}
            placeholder="What should the agent accomplish?"
          />
        </Field>
        <div className="flex items-center justify-between text-[11px] text-zinc-600">
          <div className="flex items-center gap-2">
            <Shield className="h-3 w-3" />
            Actions are policy-validated before execution.
          </div>
          <span>{objective.length}/1000</span>
        </div>

        <Field
          label="Approved origins"
          hint="Comma-separated. Leave blank to use the server demo origin."
        >
          <div className="relative">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-600" />
            <Input
              value={origins}
              onChange={(event) => setOrigins(event.target.value)}
              placeholder="http://127.0.0.1:3001"
              className="pl-8"
            />
          </div>
        </Field>

        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setObjective(example)}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-800 rounded-full px-2.5 py-1 transition-colors"
            >
              {example.length > 56 ? `${example.slice(0, 56)}…` : example}
            </button>
          ))}
        </div>

        {error && (
          <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" loading={loading} icon={<Play className="h-4 w-4" />}>
            Plan & Run
          </Button>
        </div>
      </form>
    </Card>
  );
}
