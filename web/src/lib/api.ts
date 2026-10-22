import type { CaseSummary, CaseView, EvaluationResults, SandboxState, Session } from './types';
import { isWakeFailure, retryWhileWaking, WAKE_STATUSES } from './wake';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A failure caused by the demo server still starting, rather than by the request. */
function serverWaking(error: unknown): boolean {
  return (
    isWakeFailure(error) ||
    (error instanceof ApiError &&
      (WAKE_STATUSES.has(error.status) || error.code === 'bad_response'))
  );
}

/** Reads are retried while the demo server wakes; changes are never repeated. */
function request<T>(path: string, init?: RequestInit): Promise<T> {
  const once = () => send<T>(path, init);
  return (init?.method ?? 'GET') === 'GET' ? retryWhileWaking(once, serverWaking) : once();
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(
      'bad_response',
      `The server sent an unreadable response (HTTP ${res.status}).`,
      res.status,
    );
  }
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      error?.code ?? 'http_error',
      error?.message ?? `Request failed (HTTP ${res.status}).`,
      res.status,
    );
  }
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  session: () => request<Session>('/api/session'),
  cases: () => request<{ cases: CaseSummary[] }>('/api/cases').then((r) => r.cases),
  getCase: (id: string) => request<CaseView>(`/api/cases/${encodeURIComponent(id)}`),
  assessments: (id: string) =>
    request<{
      assessments: {
        id: string;
        createdAt: string;
        nextStep: string;
        nextState: string;
        headline: string;
      }[];
    }>(`/api/cases/${encodeURIComponent(id)}/assessments`).then((r) => r.assessments),
  evaluation: () => request<{ available: boolean; results?: EvaluationResults }>('/api/evaluation'),
  sandbox: () => request<SandboxState>('/api/demo/sandbox'),
  reset: () => post<{ removedCases: number }>('/api/demo/reset'),
  script: (outcome: string, caseId: string | null) =>
    post<SandboxState>('/api/demo/script', { outcome, caseId }),
  carrierConflict: (id: string) =>
    post<CaseView>(`/api/demo/cases/${encodeURIComponent(id)}/carrier-conflict`),
  thirdPartyClaim: (id: string) =>
    post<CaseView>(`/api/demo/cases/${encodeURIComponent(id)}/third-party-claim`),
};
