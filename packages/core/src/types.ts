export type TaskStatus = 
  | 'IDLE'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DEGRADED';

export interface Task {
  id: string;
  objective: string;
  status: TaskStatus;
  currentStepIndex: number;
  lastEventId: string | null;
}

export type TaskEventType = 
  | 'ACTION_STARTED'
  | 'ACTION_FINISHED'
  | 'VERIFICATION_RESULT'
  | 'ERROR';

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export type Action = 
  | { type: 'NAVIGATE'; payload: { url: string } }
  | { type: 'SCREENSHOT'; payload: { name: string } };

export type ActionType = Action['type'];

export interface Evidence {
  id: string;
  taskId: string;
  type: 'screenshot';
  filename: string;
  timestamp: number;
}
