'use client';

import React, { useState } from 'react';
import { ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { PendingApproval } from '../lib/types';
import { Button } from './ui/Button';

interface ApprovalPanelProps {
  approval: PendingApproval;
  onDecide: (decision: 'approve' | 'reject') => Promise<void>;
}

export function ApprovalPanel({ approval, onDecide }: ApprovalPanelProps) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    try {
      await onDecide(decision);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-5">
      <div className="flex flex-col md:flex-row md:items-start gap-4">
        <div className="flex items-start gap-3 flex-1">
          <ShieldCheck className="h-5 w-5 text-amber-300 mt-0.5 shrink-0" />
          <div>
            <h3 className="text-amber-100 font-medium">Approval required</h3>
            <p className="text-xs text-amber-100/80 mt-1">{approval.reason}</p>
            <p className="text-xs text-amber-100/60 mt-2">
              Step {approval.stepIndex + 1} · {approval.action.type}
            </p>
          </div>
        </div>
        <div className="flex gap-2 md:shrink-0">
          <Button
            variant="success"
            size="sm"
            loading={busy === 'approve'}
            onClick={() => void decide('approve')}
            icon={<ThumbsUp className="h-3.5 w-3.5" />}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={busy === 'reject'}
            onClick={() => void decide('reject')}
            icon={<ThumbsDown className="h-3.5 w-3.5" />}
          >
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}
