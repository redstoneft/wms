// Typed fetch wrapper for the WMS API.
//  - same-origin `/api` (Vite proxy in dev, nginx in prod), cookies included
//  - X-Requested-With: wms-client on every mutation (CSRF guard)
//  - X-Device-Id on every request
//  - Idempotency-Key + automatic retry (max 3) ONLY for keyed requests
//  - offline detection via failed fetches
import { getDeviceId, newUuid } from '../lib/device';
import { reportNetworkFailure, reportNetworkSuccess } from '../lib/online';

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
  request_id?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.error || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error ?? 'ERROR';
    this.details = body.details;
    this.requestId = body.request_id;
  }
  get isRule() {
    return this.status === 422;
  }
  get isConflict() {
    return this.status === 409;
  }
  get isMfaRequired() {
    return this.status === 403 && typeof this.details === 'object' && this.details !== null && (this.details as { code?: string }).code === 'MFA_REQUIRED';
  }
}

export class NetworkError extends Error {
  constructor(message = 'Sin conexión con el servidor') {
    super(message);
    this.name = 'NetworkError';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** multipart body — sent as-is, no JSON header */
  formData?: FormData;
  /** Provide a key to make the request idempotent + retryable. Generate ONE key per user action and reuse it on retries. */
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** raw text response (CSV, ZPL) */
  text?: boolean;
}

export interface ApiResult<T> {
  data: T;
  status: number;
  /** true when the server replayed a stored result for a reused Idempotency-Key */
  replayed: boolean;
}

type UnauthorizedHandler = () => void;
type MfaHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
let onMfaRequired: MfaHandler | null = null;

export function setAuthHandlers(h: { unauthorized: UnauthorizedHandler; mfaRequired: MfaHandler }) {
  onUnauthorized = h.unauthorized;
  onMfaRequired = h.mfaRequired;
}

const BASE = '/api';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RETRY_DELAYS = [500, 1500, 3000];

function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith('/') ? `${BASE}${path}` : `${BASE}/${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}?${qs}` : url;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once<T>(method: string, url: string, opts: RequestOptions): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json, text/plain;q=0.9', 'X-Device-Id': getDeviceId() };
  if (MUTATING.has(method)) headers['X-Requested-With'] = 'wms-client';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.formData) body = opts.formData;
  else if (opts.body !== undefined || MUTATING.has(method)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), opts.timeoutMs ?? 20_000);
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, credentials: 'include', signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
    if (opts.signal?.aborted) throw e;
    reportNetworkFailure();
    throw new NetworkError(e instanceof DOMException && e.name === 'TimeoutError' ? 'Tiempo de espera agotado' : undefined);
  }
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onOuterAbort);
  reportNetworkSuccess();

  const replayed = res.headers.get('Idempotent-Replayed') === 'true';
  const ct = res.headers.get('content-type') ?? '';
  let payload: unknown = null;
  if (res.status !== 204) {
    if (opts.text || !ct.includes('application/json')) payload = await res.text();
    else {
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
    }
  }
  if (!res.ok) {
    const errBody: ApiErrorBody =
      payload && typeof payload === 'object' ? (payload as ApiErrorBody) : { error: `HTTP_${res.status}`, message: typeof payload === 'string' && payload ? payload : res.statusText };
    const err = new ApiError(res.status, errBody);
    if (res.status === 401) onUnauthorized?.();
    if (err.isMfaRequired) onMfaRequired?.();
    throw err;
  }
  return { data: payload as T, status: res.status, replayed };
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const url = buildUrl(path, opts.query);
  const retryable = !!opts.idempotencyKey || !MUTATING.has(method);
  const maxAttempts = retryable ? 3 : 1;
  let attempt = 0;
  for (;;) {
    try {
      return await once<T>(method, url, opts);
    } catch (e) {
      attempt++;
      const network = e instanceof NetworkError;
      if (!network || attempt >= maxAttempts || opts.signal?.aborted) throw e;
      await sleep(RETRY_DELAYS[attempt - 1] ?? 3000);
    }
  }
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: Omit<RequestOptions, 'query'>) => request<T>('GET', path, { ...opts, query }).then((r) => r.data),
  getText: (path: string, query?: Query) => request<string>('GET', path, { query, text: true }).then((r) => r.data),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) => request<T>('POST', path, { ...opts, body }).then((r) => r.data),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) => request<T>('PUT', path, { ...opts, body }).then((r) => r.data),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) => request<T>('PATCH', path, { ...opts, body }).then((r) => r.data),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts).then((r) => r.data),
  /** Movement-producing POST: needs an Idempotency-Key (generated per user action). Returns replay flag. */
  postIdem: <T>(path: string, body: unknown, key: string, opts?: Omit<RequestOptions, 'body' | 'idempotencyKey'>) =>
    request<T>('POST', path, { ...opts, body, idempotencyKey: key }),
  upload: <T>(path: string, formData: FormData, query?: Query) => request<T>('POST', path, { formData, query }).then((r) => r.data),
  newKey: () => newUuid(),
};

/** Human readable message for any thrown error. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400 && Array.isArray((e.details as { path?: string }[] | undefined))) {
      const d = e.details as { path: string; message: string }[];
      return `Datos inválidos: ${d.map((x) => `${x.path || 'campo'}: ${x.message}`).join('; ')}`;
    }
    return e.message;
  }
  if (e instanceof NetworkError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
