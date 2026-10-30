'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ListChecks } from 'lucide-react';
import { api } from '../lib/api';
import type { ModelHealth, Task, TaskEvent } from '../lib/types';
import { Sidebar, type View } from '../components/Sidebar';
import { MobileNav } from '../components/MobileNav';
import { TaskComposer } from '../components/TaskComposer';
import { TaskHistory } from '../components/TaskHistory';
import { TaskDetail } from '../components/TaskDetail';
import { SkillsPanel } from '../components/SkillsPanel';
import { ResearchPanel } from '../components/ResearchPanel';

export default function DashboardPage() {
  const [view, setView] = useState<View>('dashboard');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [modelHealth, setModelHealth] = useState<ModelHealth | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTasks = useCallback(async () => {
    try {
      const res = await api.getTasks();
      setTasks(res.tasks);
    } catch {
      // History is non-critical.
    }
  }, []);

  const refreshModelHealth = useCallback(async () => {
    try {
      setModelHealth(await api.getHealth());
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
        const [taskRes, eventsRes, shotRes] = await Promise.allSettled([
          api.getTask(selectedId),
          api.getEvents(selectedId),
          api.getScreenshotUrl(selectedId),
        ]);
        if (cancelled) return;
        if (taskRes.status === 'fulfilled') {
          setTask(taskRes.value);
          setError(taskRes.value.error ?? null);
        }
        if (eventsRes.status === 'fulfilled') {
          setEvents(eventsRes.value.events);
        }
        if (shotRes.status === 'fulfilled') {
          const base = process.env.NEXT_PUBLIC_GHOST_API_URL || 'http://localhost:3002';
          setScreenshotUrl(`${base}${shotRes.value.url}`);
        } else {
          setScreenshotUrl(null);
        }
        const next = taskRes.status === 'fulfilled' ? taskRes.value : null;
        if (next && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(next.status)) {
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
    setView('dashboard');
    setSelectedId(id);
    setTask(null);
    setEvents([]);
    setScreenshotUrl(null);
    setError(null);
  };

  const startTask = async (objective: string, origins: string[]) => {
    setIsStarting(true);
    setError(null);
    try {
      const res = await api.startTask(objective, origins.length ? origins : undefined);
      selectTask(res.taskId);
      await refreshTasks();
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'Unable to start task';
      setError(message);
      throw startError;
    } finally {
      setIsStarting(false);
    }
  };

  const cancelTask = async () => {
    if (!task) return;
    try {
      const res = await api.cancelTask(task.id);
      setTask(res.task);
      await refreshTasks();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Cancel failed');
    }
  };

  const decideApproval = async (decision: 'approve' | 'reject') => {
    if (!task?.pendingApproval) return;
    try {
      const res = await api.decideApproval(task.id, decision, task.pendingApproval.id);
      setTask(res.task);
      await refreshTasks();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Approval failed');
    }
  };

  const saveSkill = async (name: string): Promise<{ inputs: string[] }> => {
    if (!task?.plan) return { inputs: [] };
    const res = await api.saveTaskAsSkill(task.id, name);
    return { inputs: res.inputs };
  };

  const retryTask = async () => {
    if (!task) return;
    await startTask(task.objective, task.approvedOrigins ?? []);
  };

  const connected = Boolean(
    modelHealth?.capabilities?.connected &&
      modelHealth?.capabilities?.modelAvailable &&
      !modelHealth?.error
  );
  const modelLabel = modelHealth?.error
    ? `${modelHealth.error.code}: ${modelHealth.error.message}`
    : modelHealth?.capabilities
      ? `${modelHealth.capabilities.plannerModel}${modelHealth.capabilities.version ? ` · Ollama ${modelHealth.capabilities.version}` : ''}`
      : 'Checking local model…';

  return (
    <div className="flex min-h-screen bg-[#0a0a0a] text-zinc-100">
      <Sidebar
        activeView={view}
        onNavigate={setView}
        modelConnected={connected}
        modelLabel={modelLabel}
      />
      <div className="flex-1 min-w-0">
        <MobileNav activeView={view} onNavigate={setView} />
        <main className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
          <header className="hidden lg:block">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-600">Command center</p>
            <h1 className="text-2xl font-semibold tracking-tight text-white mt-1">
              {view === 'dashboard' && 'Browser automation workspace'}
              {view === 'skills' && 'Reusable skills'}
              {view === 'research' && 'Structured research'}
            </h1>
            <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
              {view === 'dashboard' &&
                'Describe an outcome. GHOST plans, validates, executes, and verifies against approved origins.'}
              {view === 'skills' &&
                'Create parameterized workflows and run them through the same policy-gated engine.'}
              {view === 'research' &&
                'Visit approved pages, extract fields, and export evidence-backed findings.'}
            </p>
          </header>

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 flex items-start gap-3">
              <AlertTriangle className="h-4 w-4 text-red-300 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-medium text-red-200">Attention</p>
                <p className="text-xs text-red-200/80 mt-0.5 break-words">{error}</p>
              </div>
              <button
                onClick={() => setError(null)}
                className="text-[11px] text-red-200/70 hover:text-red-100"
              >
                Dismiss
              </button>
            </div>
          )}

          {view === 'dashboard' && (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-6">
              <div className="space-y-6">
                <TaskComposer onStart={startTask} loading={isStarting} />
                <TaskHistory tasks={tasks} selectedId={selectedId} onSelect={selectTask} />
              </div>
              <div className="min-w-0">
                {!task ? (
                  <div className="rounded-2xl border border-zinc-800 bg-[#0d0d0d] min-h-[420px] flex flex-col items-center justify-center text-zinc-500 gap-6 p-8">
                    <div className="h-14 w-14 rounded-2xl bg-zinc-900 border border-zinc-800 grid place-items-center">
                      <ListChecks className="h-7 w-7 text-zinc-600" />
                    </div>
                    <div className="text-center max-w-sm">
                      <h2 className="text-base font-medium text-zinc-200">Ready when you are</h2>
                      <p className="text-sm text-zinc-500 mt-1">
                        Submit an objective or select a persisted task. Every run is planned, policy-checked,
                        executed, and verified against the approved origins.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-lg mt-2">
                      {[
                        ['Plan', 'LLM proposes'],
                        ['Validate', 'Schema + policy'],
                        ['Execute', 'Playwright'],
                        ['Verify', 'DOM + evidence'],
                      ].map(([title, detail], index) => (
                        <div key={title} className="rounded-xl border border-zinc-800 bg-[#0a0a0a] p-3">
                          <p className="text-[10px] text-zinc-600 mb-1">0{index + 1}</p>
                          <p className="text-xs font-medium text-zinc-300">{title}</p>
                          <p className="text-[10px] text-zinc-600">{detail}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <TaskDetail
                    task={task}
                    events={events}
                    screenshotUrl={screenshotUrl}
                    onCancel={cancelTask}
                    onApprove={decideApproval}
                    onSaveSkill={saveSkill}
                    onRetry={retryTask}
                  />
                )}
              </div>
            </div>
          )}

          {view === 'skills' && (
            <SkillsPanel onSelectTask={selectTask} onError={setError} />
          )}

          {view === 'research' && (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-6">
              <ResearchPanel onSelectTask={selectTask} onError={setError} />
              <div>
                {task ? (
                  <TaskDetail
                    task={task}
                    events={events}
                    screenshotUrl={screenshotUrl}
                    onCancel={cancelTask}
                    onApprove={decideApproval}
                    onSaveSkill={saveSkill}
                    onRetry={retryTask}
                  />
                ) : (
                  <div className="rounded-2xl border border-zinc-800 bg-[#0d0d0d] min-h-[320px] flex flex-col items-center justify-center text-zinc-500 gap-4 p-8">
                    <div className="h-12 w-12 rounded-2xl bg-zinc-900 border border-zinc-800 grid place-items-center">
                      <ListChecks className="h-6 w-6 text-zinc-600" />
                    </div>
                    <div className="text-center max-w-sm">
                      <h2 className="text-base font-medium text-zinc-200">No research selected</h2>
                      <p className="text-sm text-zinc-500 mt-1">
                        Run a research task to see extracted fields, sources, and exportable findings here.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
