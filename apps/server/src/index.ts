import Fastify from 'fastify';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import fastifyStatic from '@fastify/static';
import { Task, TaskStatus, ActionType } from '@ghost/core';
import { TaskRepository, EvidenceRepository } from '@ghost/storage';
import { ExecutionEngine } from '@ghost/engine';
import { PrismaClient } from '@prisma/client';

const fastify = Fastify({ logger: true });

// Configuration
const ALLOWED_ORIGIN = 'http://127.0.0.1:3001';
const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  ? path.resolve(process.env.EVIDENCE_DIR)
  : fs.existsSync(path.resolve(process.cwd(), 'evidence_store'))
    ? path.resolve(process.cwd(), 'evidence_store')
    : path.resolve(process.cwd(), '../../evidence_store');

// Ensure evidence dir exists
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

// Initialize DB
const prisma = new PrismaClient();
const taskRepo = new TaskRepository(prisma);
const evidenceRepo = new EvidenceRepository(EVIDENCE_DIR);

// Engine
const engine = new ExecutionEngine(
  taskRepo,
  evidenceRepo,
  ALLOWED_ORIGIN,
  EVIDENCE_DIR
);

// Register static plugin to serve evidence
fastify.register(fastifyStatic, {
  root: EVIDENCE_DIR,
  prefix: '/evidence/',
});

// Routes
fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post('/tasks/start', async (request, reply) => {
  const taskId = crypto.randomUUID();
  const task: Task = {
    id: taskId,
    objective: 'Demo vertical slice: Navigate and capture screenshot',
    status: 'IDLE',
    currentStepIndex: 0,
    lastEventId: null
  };

  await taskRepo.create(task);

  // Plan: 1. Navigate, 2. Screenshot
  const plan = [
    { type: 'NAVIGATE', payload: { url: ALLOWED_ORIGIN } },
    { type: 'SCREENSHOT', payload: { name: 'full-page' } }
  ];

  // Fire and forget the execution
  (async () => {
    try {
      await engine.executePlan(task, plan as any);
    } catch (e) {
      console.error('Background execution failed', e);
    }
  })();

  return { taskId };
});

fastify.get('/tasks/:id', async (request: any) => {
  const { id } = request.params;
  const task = await taskRepo.getById(id);
  if (!task) return { error: 'Not found' };
  return task;
});

fastify.get('/tasks/:id/events', async (request: any) => {
  const { id } = request.params;
  const events = await taskRepo.getEvents(id);
  return events;
});

fastify.get('/tasks/:id/screenshot-url', async (request: any) => {
  const { id } = request.params;
  const task = await taskRepo.getById(id);
  if (!task) return { error: 'Not found' };

  const events = await taskRepo.getEvents(id);
  const screenshotEvent = events.find(e => e.type === 'ACTION_FINISHED' && 'screenshot' in e.data && e.data.screenshot);
  
  if (!screenshotEvent) return { error: 'No screenshot found' };

  const screenshotName = screenshotEvent.data.screenshot as string;
  return { url: `/evidence/${screenshotName}` };
});

const start = async () => {
  try {
    await fastify.listen({ port: 3002, host: '0.0.0.0' });
    console.log('GHOST Server running at http://localhost:3002');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
