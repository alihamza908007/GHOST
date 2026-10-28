import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum([
    'IDLE',
    'EXECUTING',
    'VERIFYING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'DEGRADED'
  ]),
  currentStepIndex: z.number(),
  lastEventId: z.string().nullable(),
});

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('NAVIGATE'),
    payload: z.object({ url: z.string().url() }),
  }),
  z.object({
    type: z.literal('SCREENSHOT'),
    payload: z.object({ name: z.string() }),
  }),
]);

export const EventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.enum(['ACTION_STARTED', 'ACTION_FINISHED', 'VERIFICATION_RESULT', 'ERROR']),
  timestamp: z.number(),
  data: z.record(z.unknown()),
});

export const EvidenceSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.literal('screenshot'),
  filename: z.string(),
  timestamp: z.number(),
});
