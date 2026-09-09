// Guided warehouse-mode training (capacitación obligatoria).
import { api } from './client';

export type TrainingStepKey = 'RECEIVE' | 'PUTAWAY' | 'TRANSFER' | 'REPLENISH' | 'COUNT' | 'ASSEMBLY' | 'PICK' | 'STAGE' | 'VERIFY' | 'LOAD';
export interface TrainingStep {
  key: TrainingStepKey;
  label: string;
  page: string;
  goal: string;
  status: 'COMPLETED' | 'CURRENT' | 'LOCKED';
  prepared: boolean;
  prepared_at: string | null;
  completed_at: string | null;
  attempts: number;
  instructions: string[];
  codes: { label: string; value: string }[];
}
export interface MyTraining {
  required: boolean;
  completed_at: string | null;
  steps_done: number;
  steps_total: number;
  current: TrainingStepKey | null;
  steps: TrainingStep[];
  school: { warehouse: string; dock: string; staging: string; ship: string };
}
export interface TrainingCheck {
  ok: boolean;
  step: TrainingStepKey;
  hint: string;
  evidence: Record<string, unknown> | null;
  training_completed: boolean;
}
export interface TrainingUserRow {
  id: string;
  username: string;
  full_name: string;
  roles: string[];
  completed_at: string | null;
  waived: boolean;
  steps: { step: string; status: string; completed_at: string | null; attempts: number }[];
}

export const trainingApi = {
  me: () => api.get<MyTraining>('/training'),
  prepare: (step: TrainingStepKey) => api.post<{ step: TrainingStepKey; prepared: boolean; instructions: string[]; codes: { label: string; value: string }[] }>(`/training/steps/${step.toLowerCase()}/prepare`),
  check: (step: TrainingStepKey) => api.post<TrainingCheck>(`/training/steps/${step.toLowerCase()}/check`),
  labelsUrl: '/api/training/labels.html',
  users: () => api.get<TrainingUserRow[]>('/training/users'),
  reset: (id: string) => api.post<{ ok: true }>(`/training/users/${id}/reset`),
  resetSchool: (reason: string) => api.post<{ ok: true; lpns: number; pieces: string; orders: number }>('/training/school/reset', { reason }),
  waive: (id: string, reason: string) => api.post<{ ok: true }>(`/training/users/${id}/waive`, { reason }),
};
