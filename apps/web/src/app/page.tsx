'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Image as ImageIcon,
  ShieldCheck,
  AlertTriangle,
  ListChecks,
  RotateCcw,
  History,
  Cpu,
  Ban,
  ThumbsUp,
  ThumbsDown,
  Eye,
} from 'lucide-react';

const API = process.env.NEXT_PUBLIC_GHOST_API_URL || 'http://localhost:3002';

interface TaskEvent {
  id: string;
  type: string;
  timestamp: number;
  seq?: number;
  data: Record<string, unknown>;
}

interface PlanStep {
  action: {
    type: string;
    payload: Record<string, unknown>;
  };
  description: string;
  expectation: { kind: string; value?: string };
  rationale?: string;
}

interface Plan {
  objectiveSummary: string;
  steps: PlanStep[];
  rationale?: string;
}

interface PendingApproval {
  id: string;
  stepIndex: number;
  action: { type: string; payload: Record<string, unknown> };
  status: string;
  reason: string;
}

interface Task {
  id: string;
  objective: string;
  status: string;
  currentStepIndex: number;
  currentStep?: number;
  plan: Plan | null;
  approvedOrigins?: string[] | null;
  planSummary?: string | null;
  plannerModel?: string | null;
  error?: string | null;
  createdAt?: number;
  pendingApproval?: PendingApproval | null;
}

interface ModelHealth {
  capabilities: {
    plannerModel: string;
    connected: boolean;
    modelAvailable: boolean;
    textGeneration: boolean;
    structuredOutput: boolean;
    vision: boolean;
    version?: string;
    degradedFeatures: string[];
    lastErrorCode?: string;
    checkedAt: number;
  } | null;
  error: { code: string; message: string } | null;
}

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

const STAGE_ORDER = ['PLANNING', 'PLAN_READY', 'EXECUTING', 'VERIFYING', 'RETRYING', 'COMPLETED'];

const MAX_RECOVERY_LIMIT = 2;

function statusColor(status: string): string {
  if (status === 'COMPLETED') return 'bg-green-500/10 text-green-400 border-green-500/20';
  if (status === 'FAILED') return 'bg-red-500/10 text-red-400 border-red-500/20';
  if (status === 'CANCELLED') return 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20';
  if (status === 'AWAITING_APPROVAL') return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
  if (status === 'RETRYING') return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
  return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
}

function stageIndex(status: string): number {
  if (TERMINAL.includes(status)) return STAGE_ORDER.indexOf('COMPLETED');
  return Math.max(0, STAGE_ORDER.indexOf(status));
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
            ? `${data.stepCount ?? '?'} steps, ${data.attempts ?? 1} attempt(s), ${data.latencyMs}ms`
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

export default function Dashboard() {
  const [objective, setObjective] = useState(
    'Open the GHOST demo application, fill the Email field with demo@example.com, click Sign in, and capture a screenshot.'
  );
  const [approvedOrigins, setApprovedOrigins] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelHealth, setModelHealth] = useState<ModelHealth | null>(null);

  const refreshTasks = useCallback(async () => {
    try {
      const res = await fetch(`${API}/tasks`);
      if (!res.ok) throw new Error('Unable to load task history');
      const data = await res.json();
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch {
      // History is non-critical; keep the current view usable.
    }
  }, []);

  const refreshModelHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API}/health/model`);
      if (!res.ok) throw new Error('Model health request failed');
      setModelHealth(await res.json());
    } catch {
      setModelHealth({
        capabilities: null,
        error: { code: 'CONNECTION_FAILED', message: 'GHOST server is not reachable' },
      });
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
    void refreshModelHealth();
  }, [refreshTasks, refreshModelHealth]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const taskRes = await fetch(`${API}/tasks/${selectedId}`);
        if (!taskRes.ok) throw new Error('Task not found');
        const updatedTask: Task = await taskRes.json();
        if (cancelled) return;

        const eventsRes = await fetch(`${API}/tasks/${selectedId}/events`);
        const eventsData = eventsRes.ok ? await eventsRes.json() : { events: [] };
        if (cancelled) return;

        setTask(updatedTask);
        setEvents(Array.isArray(eventsData.events) ? eventsData.events : []);
        setError(updatedTask.error ?? null);

        const shotRes = await fetch(`${API}/tasks/${selectedId}/screenshot-url`);
        if (cancelled) return;
        if (shotRes.ok) {
          const shot = await shotRes.json();
          setScreenshotUrl(shot.url ? `${API}${shot.url}` : null);
        } else {
          setScreenshotUrl(null);
        }

        if (TERMINAL.includes(updatedTask.status)) {
          void refreshTasks();
          void refreshModelHealth();
          return;
        }
        timer = setTimeout(tick, 1000);
      } catch (pollError) {
        if (cancelled) return;
        setError(pollError instanceof Error ? pollError.message : 'Polling failed');
        timer = setTimeout(tick, 2000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedId, refreshTasks, refreshModelHealth]);

  const selectTask = (id: string) => {
    setSelectedId(id);
    setTask(null);
    setEvents([]);
    setScreenshotUrl(null);
    setError(null);
  };

  const startTask = async (objectiveOverride?: string) => {
    const finalObjective = (objectiveOverride ?? objective).trim();
    if (!finalObjective) return;
    setIsStarting(true);
    setError(null);
    try {
      const res = await fetch(`${API}/tasks/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: finalObjective,
          approvedOrigins: approvedOrigins
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to start task');
      selectTask(data.taskId);
      void refreshTasks();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Unable to start task');
    } finally {
      setIsStarting(false);
    }
  };

  const decideApproval = async (decision: 'approve' | 'reject') => {
    if (!task?.pendingApproval) return;
    setApprovalBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/tasks/${task.id}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          approvalId: task.pendingApproval.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Approval decision failed');
      setTask(data.task);
      void refreshTasks();
    } catch (decisionError) {
      setError(
        decisionError instanceof Error ? decisionError.message : 'Approval decision failed'
      );
    } finally {
      setApprovalBusy(false);
    }
  };

  const cancelTask = async () => {
    if (!task) return;
    try {
      const res = await fetch(`${API}/tasks/${task.id}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cancel failed');
      setTask(data.task);
      void refreshTasks();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Cancel failed');
    }
  };

  const health = modelHealth?.capabilities;
  const modelOk = Boolean(health?.connected && health?.modelAvailable && !modelHealth?.error);
  const modelDetail = modelHealth?.error
    ? `${modelHealth.error.code}: ${modelHealth.error.message}`
    : health
      ? `${health.plannerModel}${health.version ? ` · Ollama ${health.version}` : ''}`
      : 'Checking local model…';

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] font-sans p-6 md:p-8">
      <header className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between md:items-center gap-4 mb-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tighter text-white">GHOST</h1>
          <p className="text-zinc-500">
            Phase 2 · LLM proposes → Zod validates → policy authorizes → engine executes → verifier checks
          </p>
        </div>
        <div
          className={`flex items-center gap-2 text-xs rounded-full border px-3 py-2 ${
            modelOk
              ? 'border-green-500/20 bg-green-500/10 text-green-300'
              : 'border-amber-500/20 bg-amber-500/10 text-amber-200'
          }`}
          title={modelDetail}
        >
          <Cpu className="w-4 h-4" />
          <span className="max-w-[360px] truncate">{modelDetail}</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="space-y-6">
          <div className="bg-[#161616] border border-zinc-800 p-5 rounded-2xl">
            <h2 className="text-zinc-400 text-sm font-medium mb-3">Objective</h2>
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              rows={5}
              maxLength={1000}
              className="w-full bg-[#0d0d0d] border border-zinc-800 rounded-xl p-3 text-sm text-zinc-200 outline-none focus:border-zinc-600 resize-none"
            />
            <div className="flex items-center justify-between mt-3 gap-3">
              <span className="text-[11px] text-zinc-600">{objective.length}/1000</span>
              <label className="text-[11px] text-zinc-600 block mb-1">Approved origins (comma-separated, optional)</label>
              <input
                value={approvedOrigins}
                onChange={(event) => setApprovedOrigins(event.target.value)}
                placeholder="http://127.0.0.1:3001"
                className="w-full bg-[#0d0d0d] border border-zinc-800 rounded-xl p-2 text-xs text-zinc-200 outline-none focus:border-zinc-600"
              />
            </div>
            <div className="flex items-center justify-end mt-3">
              <button
                onClick={() => void startTask()}
                disabled={isStarting || !objective.trim()}
                className="bg-white text-black px-5 py-2 rounded-full text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {isStarting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Plan & Run
              </button>
            </div>
          </div>

          <div className="bg-[#161616] border border-zinc-800 p-5 rounded-2xl">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-zinc-400 text-sm font-medium flex items-center gap-2">
                <History className="w-4 h-4" /> Task history
              </h2>
              <span className="text-[11px] text-zinc-600">persisted</span>
            </div>
            <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
              {tasks.length === 0 && (
                <p className="text-zinc-600 text-sm">No tasks recorded yet.</p>
              )}
              {tasks.map((historyTask) => (
                <button
                  key={historyTask.id}
                  onClick={() => selectTask(historyTask.id)}
                  className={`w-full text-left p-3 rounded-xl border transition-colors ${
                    selectedId === historyTask.id
                      ? 'border-zinc-600 bg-zinc-900'
                      : 'border-zinc-800 bg-[#0d0d0d] hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${statusColor(
                        historyTask.status
                      )}`}
                    >
                      {historyTask.status}
                    </span>
                    <span className="text-[10px] text-zinc-600">
                      {historyTask.createdAt
                        ? new Date(historyTask.createdAt).toLocaleTimeString()
                        : ''}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-300 mt-2 line-clamp-2">
                    {historyTask.planSummary || historyTask.objective}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="lg:col-span-2 space-y-6">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-200 rounded-2xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">Recoverable error</p>
                <p className="text-xs mt-1 text-red-200/80 break-words">{error}</p>
              </div>
              {task && (
                <button
                  onClick={() => {
                    setObjective(task.objective);
                    void startTask(task.objective);
                  }}
                  className="text-xs border border-red-400/30 rounded-lg px-3 py-1.5 hover:bg-red-500/10 flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" /> Retry
                </button>
              )}
            </div>
          )}

          {!task ? (
            <div className="bg-[#161616] border border-zinc-800 rounded-2xl min-h-[260px] flex flex-col items-center justify-center text-zinc-600 gap-3">
              <ListChecks className="w-10 h-10" />
              <p>Submit an objective or select a persisted task.</p>
            </div>
          ) : (
            <>
              <div className="bg-[#161616] border border-zinc-800 p-5 rounded-2xl">
                <div className="flex flex-wrap items-center gap-3 justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs px-3 py-1 rounded-full border ${statusColor(task.status)}`}
                    >
                      {task.status}
                    </span>
                    <span className="text-sm text-zinc-400">
                      Step {Math.min(task.currentStepIndex + 1, task.plan?.steps.length ?? 0)} /{' '}
                      {task.plan?.steps.length ?? '?'}
                    </span>
                  </div>
                  {!TERMINAL.includes(task.status) && (
                    <button
                      onClick={cancelTask}
                      className="text-xs border border-zinc-700 text-zinc-300 rounded-lg px-3 py-1.5 hover:bg-zinc-800 flex items-center gap-1"
                    >
                      <Ban className="w-3 h-3" /> Cancel
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-6 gap-2 mt-4">
                  {STAGE_ORDER.map((stage, index) => {
                    const active = index <= stageIndex(task.status);
                    const current = index === stageIndex(task.status) && !TERMINAL.includes(task.status);
                    return (
                      <div key={stage} className="text-center">
                        <div
                          className={`h-1.5 rounded-full mb-2 ${
                            active ? 'bg-blue-500' : 'bg-zinc-800'
                          }`}
                        />
                        <span
                          className={`text-[10px] ${
                            current ? 'text-blue-300' : active ? 'text-zinc-400' : 'text-zinc-700'
                          }`}
                        >
                          {stage.replaceAll('_', ' ')}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <p className="text-sm text-zinc-300 mt-4">{task.objective}</p>
                {task.planSummary && (
                  <p className="text-xs text-zinc-500 mt-1">{task.planSummary}</p>
                )}
                {task.approvedOrigins && task.approvedOrigins.length > 0 && (
                  <p className="text-xs text-zinc-500 mt-1">
                    Approved origins: {task.approvedOrigins.join(', ')}
                  </p>
                )}
              </div>

              {task.pendingApproval && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-5">
                  <div className="flex items-start gap-3">
                    <ShieldCheck className="w-5 h-5 text-amber-300 mt-0.5" />
                    <div className="flex-1">
                      <h3 className="text-amber-100 font-medium">Approval required</h3>
                      <p className="text-xs text-amber-100/80 mt-1">
                        {task.pendingApproval.reason}
                      </p>
                      <p className="text-xs text-amber-100/60 mt-2">
                        Step {task.pendingApproval.stepIndex + 1} ·{' '}
                        {task.pendingApproval.action.type}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        disabled={approvalBusy}
                        onClick={() => decideApproval('approve')}
                        className="text-xs bg-green-500/20 text-green-200 border border-green-500/30 rounded-lg px-3 py-2 hover:bg-green-500/30 disabled:opacity-50 flex items-center gap-1"
                      >
                        <ThumbsUp className="w-3 h-3" /> Approve
                      </button>
                      <button
                        disabled={approvalBusy}
                        onClick={() => decideApproval('reject')}
                        className="text-xs bg-red-500/20 text-red-200 border border-red-500/30 rounded-lg px-3 py-2 hover:bg-red-500/30 disabled:opacity-50 flex items-center gap-1"
                      >
                        <ThumbsDown className="w-3 h-3" /> Reject
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <div className="bg-[#161616] border border-zinc-800 p-5 rounded-2xl">
                  <h2 className="text-zinc-400 text-sm font-medium mb-3 flex items-center gap-2">
                    <ListChecks className="w-4 h-4" /> Generated plan
                  </h2>
                  {!task.plan && (
                    <p className="text-zinc-600 text-sm">Waiting for a validated plan…</p>
                  )}
                  {task.plan && (
                    <ol className="space-y-3">
                      {task.plan.steps.map((step, index) => (
                        <li key={index} className="text-sm border border-zinc-800 rounded-xl p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] uppercase tracking-wide text-blue-300">
                              {step.action.type}
                            </span>
                            <span className="text-[10px] text-zinc-600">
                              {index < task.currentStepIndex ? 'done' : 'pending'}
                            </span>
                          </div>
                          <p className="text-zinc-300 mt-1">{step.description}</p>
                          <p className="text-[11px] text-zinc-600 mt-1">
                            Verify: {step.expectation.kind}
                          </p>
                          {step.rationale && (
                            <p className="text-[11px] text-zinc-500 mt-1 italic">
                              {step.rationale}
                            </p>
                          )}
                        </li>
                      ))}
                      {task.plan.rationale && (
                        <li className="text-[11px] text-zinc-500 italic border-t border-zinc-800 pt-3">
                          {task.plan.rationale}
                        </li>
                      )}
                    </ol>
                  )}
                </div>

                <div className="bg-[#161616] border border-zinc-800 p-5 rounded-2xl">
                  <h2 className="text-zinc-400 text-sm font-medium mb-3 flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Event timeline
                  </h2>
                  <div className="space-y-3 max-h-[420px] overflow-auto pr-1">
                    {events.length === 0 && (
                      <p className="text-zinc-600 text-sm">No events recorded yet.</p>
                    )}
                    {events.map((event) => {
                      const summary = eventSummary(event);
                      return (
                        <div key={event.id} className="flex gap-3 text-sm">
                          <div className="w-2 h-2 rounded-full bg-zinc-700 mt-1.5 shrink-0" />
                          <div>
                            <p className={`${summary.tone}`}>{summary.title}</p>
                            {summary.detail && (
                              <p className="text-zinc-600 text-[11px] mt-0.5 break-words">
                                {summary.detail}
                              </p>
                            )}
                            <p className="text-zinc-700 text-[10px]">
                              {new Date(event.timestamp).toLocaleTimeString()}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="bg-[#161616] border border-zinc-800 rounded-2xl overflow-hidden min-h-[220px]">
                {screenshotUrl ? (
                  <div className="w-full h-full flex flex-col">
                    <div className="p-4 border-b border-zinc-800 flex items-center gap-2 text-sm text-zinc-400">
                      <ImageIcon className="w-4 h-4" />
                      <span>Verified screenshot evidence</span>
                    </div>
                    <img src={screenshotUrl} alt="Task evidence" className="w-full h-auto object-contain" />
                  </div>
                ) : (
                  <div className="min-h-[220px] flex flex-col items-center justify-center text-zinc-600 gap-2">
                    {task.status === 'EXECUTING' || task.status === 'VERIFYING' ? (
                      <>
                        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                        <p className="text-sm">Executing and verifying…</p>
                      </>
                    ) : task.status === 'FAILED' || task.status === 'CANCELLED' ? (
                      <>
                        <XCircle className="w-8 h-8 text-red-400/70" />
                        <p className="text-sm">No verified screenshot for this task.</p>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-8 h-8 text-zinc-700" />
                        <p className="text-sm">No visual evidence captured yet.</p>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
