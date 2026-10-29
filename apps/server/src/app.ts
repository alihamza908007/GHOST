import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { ApprovalRequestRecord, CapabilitySnapshot, Plan, Task } from '@ghost/core';
import { GhostConfig } from './config.js';
import { ServiceError, TaskService } from './task-service.js';

export interface ModelHealth {
  capabilities: CapabilitySnapshot | null;
  error: { code: string; message: string } | null;
}

export interface AppDependencies {
  config: GhostConfig;
  taskService: TaskService;
  getModelHealth: () => Promise<ModelHealth>;
}

const StartBodySchema = z
  .object({
    objective: z.string().optional(),
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
    request.log.error({ code: (error as { code?: string }).code ?? 'ERROR' }, 'request failed');
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
      const task = await taskService.startTask(objective);
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

  return fastify;
}
