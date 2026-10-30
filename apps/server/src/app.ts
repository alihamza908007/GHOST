import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { ApprovalRequestRecord, CapabilitySnapshot, Plan, Task } from '@ghost/core';
import { GhostConfig } from './config.js';
import { deriveSkillFromPlan, validateSkillDefinition } from './skills.js';
import { ServiceError, TaskService } from './task-service.js';

export interface ModelHealth {
  capabilities: CapabilitySnapshot | null;
  error: { code: string; message: string } | null;
}

export interface AppDependencies {
  config: GhostConfig;
  taskService: TaskService;
  getModelHealth: () => Promise<ModelHealth>;
  skillRepo?: { save: (s: any) => Promise<void>; list: () => Promise<any[]>; get: (id: string) => Promise<any | null> };
  skillRunRepo?: { create: (r: any) => Promise<void>; complete: (id: string, status: string, error?: string) => Promise<void>; list: (skillId?: string) => Promise<any[]> };
}

const ResearchBodySchema = z
  .object({
    objective: z.string().min(1),
    approvedOrigins: z.array(z.string()).min(1),
    fields: z.array(z.object({ name: z.string().min(1), type: z.string(), description: z.string().optional() })).optional(),
    pageBudget: z.number().int().positive().max(20).optional(),
  })
  .strict();

const StartBodySchema = z
  .object({
    objective: z.string().optional(),
    approvedOrigins: z.array(z.string()).optional(),
  })
  .strict();

const ApprovalBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    approvalId: z.string().min(1).optional(),
  })
  .strict();

function redactPlan(plan: Plan | null): Plan | null {
  if (!plan) return null;
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.action.type === 'FILL'
        ? {
            ...step,
            action: {
              ...step.action,
              payload: { ...step.action.payload, value: '[redacted]' },
            },
          }
        : step
    ),
  };
}

function publicTask(task: Task): Record<string, unknown> {
  return {
    ...task,
    plan: redactPlan(task.plan ?? null),
  };
}

function publicApproval(approval: ApprovalRequestRecord | null): Record<string, unknown> | null {
  if (!approval) return null;
  return {
    ...approval,
    action:
      approval.action.type === 'FILL'
        ? {
            ...approval.action,
            payload: { ...approval.action.payload, value: '[redacted]' },
          }
        : approval.action,
  };
}

function sendServiceError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ServiceError) {
    reply.code(error.statusCode).send({ error: error.message, code: error.code });
    return;
  }
  reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}

function mapTaskStatusToRunStatus(status: string): string {
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return status;
  if (status === 'AWAITING_APPROVAL') return 'AWAITING_APPROVAL';
  return 'RUNNING';
}

export async function createApp(
  deps: AppDependencies,
  options: { logger?: boolean } = {}
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: options.logger ?? true });
  const { config, taskService } = deps;

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin && config.dashboardOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (request.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  fastify.register(fastifyStatic, {
    root: config.evidenceDir,
    prefix: '/evidence/',
  });

  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    request.log.error(
      {
        code: (error as { code?: string }).code ?? 'ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      'request failed'
    );
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      const invalidJson = (error as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY';
      reply.code(statusCode).send({
        error: invalidJson ? 'Request body must be valid JSON' : (error as Error).message,
        code: invalidJson ? 'INVALID_JSON' : 'INVALID_REQUEST',
      });
      return;
    }
    reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  fastify.get('/health', async () => ({
    status: 'ok',
    phase: 2,
    allowedOrigin: config.allowedOrigin,
    plannerModel: config.plannerModel,
  }));

  fastify.get('/health/model', async () => {
    return deps.getModelHealth();
  });

  fastify.post('/tasks/start', async (request, reply) => {
    const parsed = StartBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', code: 'INVALID_REQUEST' });
    }
    const objective =
      parsed.data.objective ?? 'Open the GHOST demo application and capture a screenshot.';
    try {
      const task = await taskService.startTask(objective, parsed.data.approvedOrigins);
      return reply.code(202).send({ taskId: task.id, task: publicTask(task) });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  fastify.post('/research', async (request, reply) => {
    const parsed = ResearchBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', code: 'INVALID_REQUEST' });
    }
    try {
      const task = await taskService.startResearch(
        parsed.data.objective,
        parsed.data.approvedOrigins,
        parsed.data.fields ?? [],
        parsed.data.pageBudget ?? 5
      );
      return reply.code(202).send({ taskId: task.id, task: publicTask(task) });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  fastify.get('/tasks', async () => {
    const tasks = await taskService.listTasks();
    return { tasks: tasks.map(publicTask) };
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    const task = await taskService.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found', code: 'NOT_FOUND' });
    const pendingApproval = await taskService.getPendingApproval(task.id);
    return {
      ...publicTask(task),
      pendingApproval: publicApproval(pendingApproval),
    };
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id/events', async (request, reply) => {
    const task = await taskService.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found', code: 'NOT_FOUND' });
    return { events: await taskService.getEvents(request.params.id) };
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id/approval', async (request, reply) => {
    const task = await taskService.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found', code: 'NOT_FOUND' });
    return { approval: publicApproval(await taskService.getPendingApproval(request.params.id)) };
  });

  fastify.post<{ Params: { id: string } }>('/tasks/:id/approval', async (request, reply) => {
    const parsed = ApprovalBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid approval decision', code: 'INVALID_REQUEST' });
    }
    try {
      const task =
        parsed.data.decision === 'approve'
          ? await taskService.approve(request.params.id, parsed.data.approvalId)
          : await taskService.reject(request.params.id, parsed.data.approvalId);
      return { task: publicTask(task) };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  fastify.post<{ Params: { id: string } }>('/tasks/:id/cancel', async (request, reply) => {
    try {
      const task = await taskService.cancelTask(request.params.id);
      return { task: publicTask(task) };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id/screenshot-url', async (request, reply) => {
    const task = await taskService.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found', code: 'NOT_FOUND' });

    const events = await taskService.getEvents(request.params.id);
    const screenshotEvent = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'VERIFICATION_RESULT' &&
          typeof event.data.evidenceRef === 'string'
      ) ?? [...events]
        .reverse()
        .find(
          (event) =>
            event.type === 'ACTION_FINISHED' &&
            typeof event.data.screenshot === 'string'
        );

    const filename =
      (screenshotEvent?.data.evidenceRef as string | undefined) ??
      (screenshotEvent?.data.screenshot as string | undefined);
    if (!filename) {
      return reply.code(404).send({ error: 'No screenshot found', code: 'NOT_FOUND' });
    }
    return { url: `/evidence/${encodeURIComponent(filename)}` };
  });

  fastify.get('/skills', async () => {
    if (!deps.skillRepo) return { skills: [] };
    const skills = await deps.skillRepo.list();
    return { skills };
  });

  fastify.post('/skills', async (request, reply) => {
    if (!deps.skillRepo) return reply.code(503).send({ error: 'Skill store unavailable', code: 'UNAVAILABLE' });
    const body = (request.body ?? {}) as { name?: unknown; definition?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim() || !body.definition) {
      return reply.code(400).send({ error: 'name and definition required', code: 'INVALID_REQUEST' });
    }
    if (body.name.trim().length > 120) {
      return reply.code(400).send({ error: 'Skill name must be 120 characters or fewer', code: 'INVALID_SKILL' });
    }
    const validated = validateSkillDefinition(body.definition);
    if ('error' in validated) {
      return reply.code(400).send({ error: validated.error, code: 'INVALID_SKILL' });
    }
    const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await deps.skillRepo.save({ id, name: body.name.trim(), definition: validated.definition });
    return reply.code(201).send({ id, definition: validated.definition });
  });

  fastify.post<{ Params: { id: string } }>('/tasks/:id/skill', async (request, reply) => {
    if (!deps.skillRepo) return reply.code(503).send({ error: 'Skill store unavailable', code: 'UNAVAILABLE' });
    const task = await taskService.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found', code: 'NOT_FOUND' });
    if (task.status !== 'COMPLETED' || !task.plan) {
      return reply
        .code(409)
        .send({ error: 'Only completed tasks with a plan can be saved as skills', code: 'TASK_NOT_COMPLETED' });
    }
    const body = (request.body ?? {}) as { name?: unknown };
    const fallback = task.planSummary ?? task.plan.objectiveSummary ?? `Skill ${task.id.slice(0, 8)}`;
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 120)
        : fallback.slice(0, 120);
    const derived = deriveSkillFromPlan(task.id, task.plan, name, task.planSummary);
    const validated = validateSkillDefinition(derived.definition);
    if ('error' in validated) {
      return reply.code(422).send({ error: validated.error, code: 'INVALID_SKILL' });
    }
    const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await deps.skillRepo.save({ id, name, definition: validated.definition });
    return reply.code(201).send({ id, inputs: derived.inputNames, definition: validated.definition });
  });

  fastify.post<{ Params: { id: string } }>('/skills/:id/run', async (request, reply) => {
    if (!deps.skillRepo) return reply.code(503).send({ error: 'Skill store unavailable', code: 'UNAVAILABLE' });
    const skill = await deps.skillRepo.get(request.params.id);
    if (!skill) return reply.code(404).send({ error: 'Skill not found', code: 'NOT_FOUND' });
    const body = (request.body ?? {}) as { inputs?: Record<string, unknown>; approvedOrigins?: string[] };
    if (body.inputs !== undefined && (typeof body.inputs !== 'object' || body.inputs === null || Array.isArray(body.inputs))) {
      return reply.code(400).send({ error: 'inputs must be an object', code: 'INVALID_REQUEST' });
    }
    if (body.approvedOrigins !== undefined && !Array.isArray(body.approvedOrigins)) {
      return reply.code(400).send({ error: 'approvedOrigins must be an array', code: 'INVALID_REQUEST' });
    }
    try {
      const task = await taskService.runSkill(skill, body.inputs ?? {}, body.approvedOrigins);
      return reply.code(202).send({ taskId: task.id });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  fastify.get<{ Params: { id: string } }>('/skills/:id/runs', async (request, reply) => {
    if (!deps.skillRunRepo) return reply.code(503).send({ error: 'Skill run store unavailable', code: 'UNAVAILABLE' });
    const runs = await deps.skillRunRepo.list(request.params.id);
    // A skill run pauses with its task for approval and resumes later, so the
    // persisted run status can lag behind the linked task. Reconcile on read so
    // history reflects the task that actually executed.
    const reconciled = await Promise.all(
      runs.map(async (run) => {
        if (!run.taskId) return run;
        try {
          const task = await taskService.getTask(run.taskId);
          if (!task) return run;
          const status = mapTaskStatusToRunStatus(task.status);
          const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status);
          return {
            ...run,
            status,
            error: task.error ?? run.error ?? null,
            completedAt: terminal ? (run.completedAt ?? new Date(task.updatedAt ?? Date.now())) : null,
          };
        } catch {
          return run;
        }
      })
    );
    return { runs: reconciled };
  });

  return fastify;
}
