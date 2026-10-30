export interface TaskEvent {
  id: string;
  type: string;
  timestamp: number;
  seq?: number;
  data: Record<string, unknown>;
}

export interface PlanStep {
  action: {
    type: string;
    payload: Record<string, unknown>;
  };
  description: string;
  expectation: { kind: string; value?: string; locator?: Record<string, string> };
  rationale?: string;
}

export interface Plan {
  objectiveSummary: string;
  steps: PlanStep[];
  rationale?: string;
}

export interface PendingApproval {
  id: string;
  stepIndex: number;
  action: { type: string; payload: Record<string, unknown> };
  status: string;
  reason: string;
}

export interface Task {
  id: string;
  objective: string;
  status: string;
  currentStepIndex: number;
  plan: Plan | null;
  approvedOrigins?: string[] | null;
  researchResultJson?: string | null;
  planSummary?: string | null;
  plannerModel?: string | null;
  error?: string | null;
  createdAt?: number;
  updatedAt?: number;
  pendingApproval?: PendingApproval | null;
}

export interface ModelHealth {
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

export interface SkillInputSpec {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  maxLength?: number;
}

export interface SkillDefinition {
  id?: string;
  name: string;
  description?: string;
  version?: number;
  inputs?: SkillInputSpec[];
  steps: PlanStep[];
  objective?: string;
}

export interface Skill {
  id: string;
  name: string;
  version: number;
  definition: SkillDefinition;
}

export interface SkillRun {
  id: string;
  skillId: string;
  skillVersion: number;
  taskId?: string | null;
  inputs: Record<string, unknown>;
  status: string;
  error?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface ResearchFinding {
  field: string;
  value: string;
  sourceUrl: string;
  status: string;
}

export interface ResearchResult {
  visited: string[];
  findings: ResearchFinding[];
  completedAt: string;
}
