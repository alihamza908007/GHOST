'use client';

import React from 'react';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';
import type { Task, ResearchResult } from '../lib/types';
import { Card } from './ui/Card';
import { Button } from './ui/Button';

interface ResearchViewProps {
  task: Task;
}

function parseResult(json: string | null | undefined): ResearchResult | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ResearchResult;
  } catch {
    return null;
  }
}

export function ResearchView({ task }: ResearchViewProps) {
  const result = parseResult(task.researchResultJson);
  if (!result) return null;

  const download = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportJson = () => {
    if (!task.researchResultJson) return;
    download(task.researchResultJson, `research-${task.id}.json`, 'application/json');
  };

  const exportCsv = () => {
    const rows = [['field', 'value', 'status', 'sourceUrl']];
    for (const finding of result.findings) {
      rows.push([finding.field, finding.value, finding.status, finding.sourceUrl]);
    }
    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    download(csv, `research-${task.id}.csv`, 'text/csv');
  };

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium text-zinc-200">Research findings</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {result.findings.length} field(s) from {result.visited.length} page(s)
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={exportJson} icon={<FileJson className="h-3 w-3" />}>
              JSON
            </Button>
            <Button size="sm" variant="secondary" onClick={exportCsv} icon={<FileSpreadsheet className="h-3 w-3" />}>
              CSV
            </Button>
          </div>
        </div>
      }
    >
      {result.findings.length === 0 ? (
        <p className="text-sm text-zinc-600">No fields could be extracted from the visited pages.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-zinc-500 uppercase tracking-wider text-[10px]">
                <th className="pb-2 pr-3 font-medium">Field</th>
                <th className="pb-2 pr-3 font-medium">Value</th>
                <th className="pb-2 pr-3 font-medium">Status</th>
                <th className="pb-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {result.findings.map((finding, index) => (
                <tr key={`${finding.field}-${index}`} className="text-zinc-300">
                  <td className="py-2 pr-3 whitespace-nowrap">{finding.field}</td>
                  <td className="py-2 pr-3">{finding.value}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        finding.status === 'verified'
                          ? 'bg-green-500/10 text-green-300 border-green-500/20'
                          : finding.status === 'unverified'
                            ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                            : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
                      }`}
                    >
                      {finding.status}
                    </span>
                  </td>
                  <td className="py-2 text-zinc-500 max-w-[220px] truncate" title={finding.sourceUrl}>
                    {finding.sourceUrl}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
