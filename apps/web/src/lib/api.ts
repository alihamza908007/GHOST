import type { ModelHealth, Skill, SkillDefinition, SkillRun, Task, TaskEvent } from './types';

const API = process.env.NEXT_PUBLIC_GHOST_API_URL || 'http://localhost:3002';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  getTasks: () => request<{ tasks: Task[] }>('/tasks'),
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  getEvents: (id: string) => request<{ events: TaskEvent[] }>(`/tasks/${id}/events`),
  startTask: (objective: string, approvedOrigins?: string[]) =>
    request<{ taskId: string; task: Task }>('/tasks/start', {
      method: 'POST',
      body: JSON.stringify({ objective, approvedOrigins }),
    }),
  cancelTask: (id: string) =>
    request<{ task: Task }>(`/tasks/${id}/cancel`, { method: 'POST' }),
  decideApproval: (id: string, decision: 'approve' | 'reject', approvalId?: string) =>
    request<{ task: Task }>(`/tasks/${id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision, approvalId }),
    }),
  getScreenshotUrl: (id: string) =>
    request<{ url: string }>(`/tasks/${id}/screenshot-url`),
  getHealth: () => request<ModelHealth>('/health/model'),
  getSkills: () => request<{ skills: Skill[] }>('/skills'),
  saveSkill: (name: string, definition: SkillDefinition) =>
    request<{ id: string }>('/skills', {
      method: 'POST',
      body: JSON.stringify({ name, definition }),
    }),
  saveTaskAsSkill: (taskId: string, name?: string) =>
    request<{ id: string; inputs: string[]; definition: SkillDefinition }>(`/tasks/${taskId}/skill`, {
      method: 'POST',
      body: JSON.stringify(name ? { name } : {}),
    }),
  runSkill: (id: string, inputs: Record<string, unknown>, approvedOrigins?: string[]) =>
    request<{ taskId: string }>(`/skills/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ inputs, approvedOrigins }),
    }),
  getSkillRuns: (id: string) => request<{ runs: SkillRun[] }>(`/skills/${id}/runs`),
  startResearch: (objective: string, approvedOrigins: string[], fields: Array<{ name: string; type: string }>, pageBudget?: number) =>
    request<{ taskId: string; task: Task }>('/research', {
      method: 'POST',
      body: JSON.stringify({ objective, approvedOrigins, fields, pageBudget }),
    }),
};
