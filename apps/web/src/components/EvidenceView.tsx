'use client';

import React from 'react';
import { Image as ImageIcon, Loader2, XCircle, CheckCircle2 } from 'lucide-react';
import { Card } from './ui/Card';

interface EvidenceViewProps {
  screenshotUrl: string | null;
  status: string;
}

export function EvidenceView({ screenshotUrl, status }: EvidenceViewProps) {
  return (
    <Card padding="none" className="min-h-[220px]">
      {screenshotUrl ? (
        <div className="flex flex-col">
          <div className="px-5 py-4 border-b border-zinc-800 flex items-center gap-2 text-sm text-zinc-300">
            <ImageIcon className="h-4 w-4 text-zinc-500" />
            Verified screenshot evidence
          </div>
          <div className="bg-[#0a0a0a]">
            <img src={screenshotUrl} alt="Task evidence" className="w-full h-auto object-contain" />
          </div>
        </div>
      ) : (
        <div className="min-h-[220px] flex flex-col items-center justify-center text-zinc-600 gap-2">
          {status === 'EXECUTING' || status === 'VERIFYING' ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              <p className="text-sm">Executing and verifying…</p>
            </>
          ) : status === 'FAILED' || status === 'CANCELLED' ? (
            <>
              <XCircle className="h-8 w-8 text-red-400/70" />
              <p className="text-sm">No verified screenshot for this task.</p>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-8 w-8 text-zinc-700" />
              <p className="text-sm">No visual evidence captured yet.</p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
