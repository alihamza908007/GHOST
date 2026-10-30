'use client';

import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../lib/api';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Field, Input, Textarea } from './ui/Input';

interface ResearchPanelProps {
  onSelectTask: (taskId: string) => void;
  onError: (message: string) => void;
}

const DEFAULT_FIELDS = `[{"name":"Product","type":"string"},{"name":"Version","type":"string"}]`;

export function ResearchPanel({ onSelectTask, onError }: ResearchPanelProps) {
  const [objective, setObjective] = useState('Extract the product name and version from the research page.');
  const [origins, setOrigins] = useState('http://127.0.0.1:3001?scenario=research');
  const [fields, setFields] = useState(DEFAULT_FIELDS);
  const [budget, setBudget] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!objective.trim()) {
      setError('Enter a research objective.');
      return;
    }
    let parsedFields: Array<{ name: string; type: string }>;
    try {
      parsedFields = JSON.parse(fields);
    } catch {
      setError('Fields must be valid JSON.');
      return;
    }
    const parsedOrigins = origins
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (parsedOrigins.length === 0) {
      setError('Add at least one approved origin.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.startResearch(objective.trim(), parsedOrigins, parsedFields, budget);
      onSelectTask(res.taskId);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Unable to start research.';
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      header={
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Search className="h-4 w-4 text-zinc-500" />
            Research task
          </div>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Visit approved pages, extract structured fields, and export the findings.
          </p>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Objective">
          <Textarea
            rows={3}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should the research collect?"
          />
        </Field>
        <Field label="Approved origins" hint="One origin per line or comma-separated.">
          <Textarea
            rows={2}
            value={origins}
            onChange={(event) => setOrigins(event.target.value)}
            placeholder="http://127.0.0.1:3001"
          />
        </Field>
        <Field label="Fields JSON" hint='Array of {"name","type"} objects.'>
          <Textarea
            rows={4}
            value={fields}
            onChange={(event) => setFields(event.target.value)}
            className="font-mono text-[11px]"
          />
        </Field>
        <Field label="Page budget">
          <Input
            type="number"
            min={1}
            max={20}
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
          />
        </Field>

        {error && (
          <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" loading={loading} icon={<Search className="h-4 w-4" />}>
            Run research
          </Button>
        </div>
      </form>
    </Card>
  );
}
