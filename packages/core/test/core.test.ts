import { describe, it, expect } from 'vitest';
import {
  isValidTransition,
  TaskStatus,
  TaskSchema,
  ActionSchema,
  EventSchema,
} from '../src/index.js';

describe('@ghost/core state machine', () => {
  it('allows valid transitions from IDLE', () => {
    expect(isValidTransition('IDLE', 'EXECUTING')).toBe(true);
    expect(isValidTransition('IDLE', 'CANCELLED')).toBe(true);
    expect(isValidTransition('IDLE', 'COMPLETED')).toBe(false);
  });

  it('allows valid transitions from EXECUTING', () => {
    expect(isValidTransition('EXECUTING', 'VERIFYING')).toBe(true);
    expect(isValidTransition('EXECUTING', 'FAILED')).toBe(true);
    expect(isValidTransition('EXECUTING', 'CANCELLED')).toBe(true);
    expect(isValidTransition('EXECUTING', 'IDLE')).toBe(false);
  });

  it('allows valid transitions from VERIFYING', () => {
    expect(isValidTransition('VERIFYING', 'COMPLETED')).toBe(true);
    expect(isValidTransition('VERIFYING', 'FAILED')).toBe(true);
    expect(isValidTransition('VERIFYING', 'CANCELLED')).toBe(true);
    expect(isValidTransition('VERIFYING', 'EXECUTING')).toBe(false);
  });

  it('terminal states have no valid transitions', () => {
    const terminalStates: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
    for (const state of terminalStates) {
      expect(isValidTransition(state, 'IDLE')).toBe(false);
      expect(isValidTransition(state, 'EXECUTING')).toBe(false);
    }
  });
});

describe('@ghost/core zod schemas', () => {
  it('validates a correct task object', () => {
    const validTask = {
      id: 'task-123',
      objective: 'Run browser navigation test',
      status: 'IDLE',
      currentStepIndex: 0,
      lastEventId: null,
    };
    expect(() => TaskSchema.parse(validTask)).not.toThrow();
  });

  it('validates NAVIGATE and SCREENSHOT action schemas', () => {
    const navAction = {
      type: 'NAVIGATE',
      payload: { url: 'http://127.0.0.1:3001' },
    };
    const screenshotAction = {
      type: 'SCREENSHOT',
      payload: { name: 'test-screenshot' },
    };

    expect(() => ActionSchema.parse(navAction)).not.toThrow();
    expect(() => ActionSchema.parse(screenshotAction)).not.toThrow();

    const invalidAction = {
      type: 'CLICK',
      payload: { selector: '#btn' },
    };
    expect(() => ActionSchema.parse(invalidAction)).toThrow();
  });

  it('validates event schema', () => {
    const event = {
      id: 'evt-1',
      taskId: 'task-123',
      type: 'ACTION_STARTED',
      timestamp: Date.now(),
      data: { step: 'NAVIGATE' },
    };
    expect(() => EventSchema.parse(event)).not.toThrow();
  });
});
