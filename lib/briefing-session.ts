import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";

export type BriefingToolName =
  | "get_digest_item"
  | "search_archive"
  | "list_archive_items"
  | "search_memory"
  | "get_memory_item"
  | "wait_for_user";
export type BriefingHandledCallStatus = "pending" | "completed" | "failed";
export type ClaimHandledCallDisposition =
  | "execute"
  | "pending"
  | "replay"
  | "tool_mismatch";
export type CompleteHandledCallStatus =
  | "completed"
  | "budget_exhausted"
  | "session_unavailable"
  | "stale_attempt";
export type FailHandledCallStatus = "failed" | "stale_attempt";

export const DEFAULT_BRIEFING_TOOL_CALL_MAX = 100;
export const DEFAULT_BRIEFING_SEARCH_ARCHIVE_MAX = 60;
export const DEFAULT_BRIEFING_RECOMMENDED_DURATION_MS = 10 * 60 * 1000;
export const DEFAULT_BRIEFING_EXPIRY_MS = 65 * 60 * 1000;
export const DEFAULT_HANDLED_CALL_LEASE_SECONDS = 30;

type TimestampInput = Date | string;

interface BriefingSessionRow {
  id: string;
  digest_id: number;
  source_item_ids: number[];
  openai_call_id: string | null;
  model?: string | null;
  prompt_hash?: string | null;
  prompt_budget_json?: unknown | null;
  tool_call_count: number;
  tool_call_max: number;
  search_archive_count: number;
  search_archive_max: number;
  client_ip_hash: string;
  recommended_end_at: string;
  expires_at: string;
  closed_at: string | null;
  hangup_attempted_at: string | null;
  hangup_succeeded_at: string | null;
  created_at: string;
}

interface HandledCallRow {
  briefing_session_id: string;
  function_call_id: string;
  tool_name: BriefingToolName;
  status: BriefingHandledCallStatus;
  lease_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  result_payload: string | null;
  request_arguments: unknown | null;
  created_at: string;
  updated_at: string;
}

interface ClaimHandledCallRow extends HandledCallRow {
  claimed: boolean;
}

interface CompleteHandledCallRow {
  session_eligible: boolean;
  call_claimable: boolean;
  budget_spent: boolean;
  completed: boolean;
  briefing_session_id: string | null;
  function_call_id: string | null;
  tool_name: BriefingToolName | null;
  status: BriefingHandledCallStatus | null;
  lease_expires_at: string | null;
  attempt_count: number | null;
  last_error: string | null;
  result_payload: string | null;
  request_arguments: unknown | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BriefingSessionRecord {
  id: string;
  digestId: number;
  sourceItemIds: number[];
  openaiCallId: string | null;
  model: string | null;
  promptHash: string | null;
  promptBudgetJson: unknown | null;
  toolCallCount: number;
  toolCallMax: number;
  searchArchiveCount: number;
  searchArchiveMax: number;
  clientIpHash: string;
  recommendedEndAt: string;
  expiresAt: string;
  closedAt: string | null;
  hangupAttemptedAt: string | null;
  hangupSucceededAt: string | null;
  createdAt: string;
}

export interface BriefingHandledCallRecord {
  briefingSessionId: string;
  functionCallId: string;
  toolName: BriefingToolName;
  status: BriefingHandledCallStatus;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
  resultPayload: unknown | null;
  requestArguments: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBriefingSessionOptions {
  id?: string;
  digestId: number;
  sourceItemIds: number[];
  clientIpHash: string;
  openaiCallId?: string | null;
  model?: string | null;
  promptHash?: string | null;
  promptBudgetJson?: unknown | null;
  toolCallMax?: number;
  searchArchiveMax?: number;
  maxActivePerIp?: number;
  recommendedEndAt?: TimestampInput;
  expiresAt?: TimestampInput;
  now?: TimestampInput;
}

export interface CloseBriefingSessionOptions {
  briefingSessionId: string;
  closedAt?: TimestampInput;
  hangupAttemptedAt?: TimestampInput | null;
  hangupSucceededAt?: TimestampInput | null;
}

export interface ClaimHandledCallExecutionOptions {
  briefingSessionId: string;
  functionCallId: string;
  toolName: BriefingToolName;
  requestArguments?: Record<string, unknown> | null;
  leaseDurationSeconds?: number;
  now?: TimestampInput;
}

export interface ClaimHandledCallExecutionResult {
  disposition: ClaimHandledCallDisposition;
  record: BriefingHandledCallRecord;
}

export interface CompleteHandledCallOptions {
  briefingSessionId: string;
  functionCallId: string;
  toolName: BriefingToolName;
  attemptCount: number;
  resultPayload: unknown;
  spendBudget?: boolean;
  now?: TimestampInput;
}

export interface CompleteHandledCallResult {
  status: CompleteHandledCallStatus;
  budgetSpent: boolean;
  record: BriefingHandledCallRecord | null;
}

export interface FailHandledCallOptions {
  briefingSessionId: string;
  functionCallId: string;
  toolName: BriefingToolName;
  attemptCount: number;
  lastError: string;
}

export interface FailHandledCallResult {
  status: FailHandledCallStatus;
  record: BriefingHandledCallRecord | null;
}

function normalizeTimestamp(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}

function getNowDate(now?: TimestampInput): Date {
  if (!now) {
    return new Date();
  }

  return now instanceof Date ? now : new Date(now);
}

function addDuration(now: Date, durationMs: number): string {
  return new Date(now.getTime() + durationMs).toISOString();
}

function serializeResultPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error("resultPayload must be JSON-serializable");
  }
  return serialized;
}

function parseResultPayload(payload: string | null): unknown | null {
  if (payload === null) {
    return null;
  }

  return JSON.parse(payload) as unknown;
}

function parseJsonValue(value: unknown): unknown | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function mapBriefingSessionRow(row: BriefingSessionRow): BriefingSessionRecord {
  return {
    id: row.id,
    digestId: row.digest_id,
    sourceItemIds: row.source_item_ids,
    openaiCallId: row.openai_call_id,
    model: row.model ?? null,
    promptHash: row.prompt_hash ?? null,
    promptBudgetJson: parseJsonValue(row.prompt_budget_json),
    toolCallCount: Number(row.tool_call_count),
    toolCallMax: Number(row.tool_call_max),
    searchArchiveCount: Number(row.search_archive_count),
    searchArchiveMax: Number(row.search_archive_max),
    clientIpHash: row.client_ip_hash,
    recommendedEndAt: row.recommended_end_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
    hangupAttemptedAt: row.hangup_attempted_at,
    hangupSucceededAt: row.hangup_succeeded_at,
    createdAt: row.created_at,
  };
}

function mapHandledCallRow(row: HandledCallRow): BriefingHandledCallRecord {
  return {
    briefingSessionId: row.briefing_session_id,
    functionCallId: row.function_call_id,
    toolName: row.tool_name,
    status: row.status,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
    resultPayload: parseResultPayload(row.result_payload),
    requestArguments: parseRequestArguments(row.request_arguments),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRequestArguments(value: unknown): unknown | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function createBriefingSession(
  options: CreateBriefingSessionOptions,
): Promise<BriefingSessionRecord | null> {
  const now = getNowDate(options.now);
  const recommendedEndAt = options.recommendedEndAt
    ? normalizeTimestamp(options.recommendedEndAt)
    : addDuration(now, DEFAULT_BRIEFING_RECOMMENDED_DURATION_MS);
  const expiresAt = options.expiresAt
    ? normalizeTimestamp(options.expiresAt)
    : addDuration(now, DEFAULT_BRIEFING_EXPIRY_MS);

  const sessionId = options.id ?? randomUUID();
  const toolCallMax = options.toolCallMax ?? DEFAULT_BRIEFING_TOOL_CALL_MAX;
  const searchArchiveMax = options.searchArchiveMax ?? DEFAULT_BRIEFING_SEARCH_ARCHIVE_MAX;
  const openaiCallId = options.openaiCallId ?? null;
  const model = options.model ?? null;
  const promptHash = options.promptHash ?? null;
  const promptBudgetJson =
    options.promptBudgetJson == null
      ? null
      : JSON.stringify(options.promptBudgetJson);

  let rows: unknown[];

  if (options.maxActivePerIp != null) {
    const nowTs = normalizeTimestamp(now);
    rows = await sql`
      INSERT INTO briefing_sessions (
        id,
        digest_id,
        source_item_ids,
        openai_call_id,
        tool_call_count,
        tool_call_max,
        search_archive_count,
        search_archive_max,
        client_ip_hash,
        recommended_end_at,
        expires_at,
        model,
        prompt_hash,
        prompt_budget_json
      )
      SELECT
        ${sessionId},
        ${options.digestId},
        ${options.sourceItemIds},
        ${openaiCallId},
        0,
        ${toolCallMax},
        0,
        ${searchArchiveMax},
        ${options.clientIpHash},
        ${recommendedEndAt}::timestamptz,
        ${expiresAt}::timestamptz,
        ${model},
        ${promptHash},
        ${promptBudgetJson}::jsonb
      WHERE (
        SELECT COUNT(*)
        FROM briefing_sessions
        WHERE client_ip_hash = ${options.clientIpHash}
          AND closed_at IS NULL
          AND expires_at > ${nowTs}::timestamptz
      ) < ${options.maxActivePerIp}
      RETURNING *
    `;
  } else {
    rows = await sql`
      INSERT INTO briefing_sessions (
        id,
        digest_id,
        source_item_ids,
        openai_call_id,
        tool_call_count,
        tool_call_max,
        search_archive_count,
        search_archive_max,
        client_ip_hash,
        recommended_end_at,
        expires_at,
        model,
        prompt_hash,
        prompt_budget_json
      )
      VALUES (
        ${sessionId},
        ${options.digestId},
        ${options.sourceItemIds},
        ${openaiCallId},
        0,
        ${toolCallMax},
        0,
        ${searchArchiveMax},
        ${options.clientIpHash},
        ${recommendedEndAt}::timestamptz,
        ${expiresAt}::timestamptz,
        ${model},
        ${promptHash},
        ${promptBudgetJson}::jsonb
      )
      RETURNING *
    `;
  }

  const row = rows[0] as BriefingSessionRow | undefined;
  return row ? mapBriefingSessionRow(row) : null;
}

export async function getBriefingSession(
  briefingSessionId: string,
): Promise<BriefingSessionRecord | null> {
  const rows = await sql`
    SELECT *
    FROM briefing_sessions
    WHERE id = ${briefingSessionId}
    LIMIT 1
  `;

  const row = rows[0] as BriefingSessionRow | undefined;
  return row ? mapBriefingSessionRow(row) : null;
}

export async function countActiveBriefingSessions(
  clientIpHash: string,
  now: TimestampInput = new Date(),
): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS count
    FROM briefing_sessions
    WHERE client_ip_hash = ${clientIpHash}
      AND closed_at IS NULL
      AND expires_at > ${normalizeTimestamp(now)}::timestamptz
  `;

  return Number((rows[0] as { count?: number | string } | undefined)?.count ?? 0);
}

export async function closeBriefingSession(
  options: CloseBriefingSessionOptions,
): Promise<BriefingSessionRecord | null> {
  const closedAt = normalizeTimestamp(options.closedAt ?? new Date());
  const hangupAttemptedAt = options.hangupAttemptedAt
    ? normalizeTimestamp(options.hangupAttemptedAt)
    : null;
  const hangupSucceededAt = options.hangupSucceededAt
    ? normalizeTimestamp(options.hangupSucceededAt)
    : null;

  const rows = await sql`
    UPDATE briefing_sessions
    SET closed_at = COALESCE(closed_at, ${closedAt}::timestamptz),
        hangup_attempted_at = COALESCE(
          hangup_attempted_at,
          ${hangupAttemptedAt}::timestamptz
        ),
        hangup_succeeded_at = COALESCE(
          hangup_succeeded_at,
          ${hangupSucceededAt}::timestamptz
        )
    WHERE id = ${options.briefingSessionId}
    RETURNING *
  `;

  const row = rows[0] as BriefingSessionRow | undefined;
  return row ? mapBriefingSessionRow(row) : null;
}

export async function getHandledCallRecord(
  briefingSessionId: string,
  functionCallId: string,
): Promise<BriefingHandledCallRecord | null> {
  const rows = await sql`
    SELECT *
    FROM briefing_handled_calls
    WHERE briefing_session_id = ${briefingSessionId}
      AND function_call_id = ${functionCallId}
    LIMIT 1
  `;

  const row = rows[0] as HandledCallRow | undefined;
  return row ? mapHandledCallRow(row) : null;
}

export async function claimHandledCallExecution(
  options: ClaimHandledCallExecutionOptions,
): Promise<ClaimHandledCallExecutionResult> {
  const now = normalizeTimestamp(options.now ?? new Date());
  const leaseDurationSeconds =
    options.leaseDurationSeconds ?? DEFAULT_HANDLED_CALL_LEASE_SECONDS;
  const requestArgumentsJson =
    options.requestArguments == null
      ? null
      : JSON.stringify(options.requestArguments);

  const rows = await sql`
    WITH claimed AS (
      INSERT INTO briefing_handled_calls (
        briefing_session_id,
        function_call_id,
        tool_name,
        status,
        lease_expires_at,
        attempt_count,
        request_arguments
      )
      SELECT
        ${options.briefingSessionId},
        ${options.functionCallId},
        ${options.toolName},
        'pending',
        ${now}::timestamptz + ${leaseDurationSeconds} * INTERVAL '1 second',
        1,
        ${requestArgumentsJson}::jsonb
      ON CONFLICT (briefing_session_id, function_call_id) DO UPDATE
      SET status = 'pending',
          lease_expires_at = EXCLUDED.lease_expires_at,
          attempt_count = briefing_handled_calls.attempt_count + 1,
          last_error = NULL,
          request_arguments = EXCLUDED.request_arguments,
          updated_at = NOW()
      WHERE briefing_handled_calls.tool_name = EXCLUDED.tool_name
        AND (
          briefing_handled_calls.status = 'failed'
          OR (
            briefing_handled_calls.status = 'pending'
            AND (
              briefing_handled_calls.lease_expires_at IS NULL
              OR briefing_handled_calls.lease_expires_at <= ${now}::timestamptz
            )
          )
        )
      RETURNING
        briefing_session_id,
        function_call_id,
        tool_name,
        status,
        lease_expires_at,
        attempt_count,
        last_error,
        result_payload,
        request_arguments,
        created_at,
        updated_at,
        TRUE AS claimed
    )
    SELECT *
    FROM claimed
    UNION ALL
    SELECT
      briefing_session_id,
      function_call_id,
      tool_name,
      status,
      lease_expires_at,
      attempt_count,
      last_error,
      result_payload,
      request_arguments,
      created_at,
      updated_at,
      FALSE AS claimed
    FROM briefing_handled_calls
    WHERE briefing_session_id = ${options.briefingSessionId}
      AND function_call_id = ${options.functionCallId}
      AND NOT EXISTS (SELECT 1 FROM claimed)
    LIMIT 1
  `;

  const row = rows[0] as ClaimHandledCallRow | undefined;
  if (!row) {
    throw new Error("Failed to claim handled call");
  }

  const record = mapHandledCallRow(row);

  if (row.claimed) {
    return { disposition: "execute", record };
  }

  if (record.toolName !== options.toolName) {
    return { disposition: "tool_mismatch", record };
  }

  if (record.status === "completed") {
    return { disposition: "replay", record };
  }

  return { disposition: "pending", record };
}

export async function completeHandledCall(
  options: CompleteHandledCallOptions,
) {
  const now = normalizeTimestamp(options.now ?? new Date());
  const spendBudget = options.spendBudget ?? true;
  const spendsSearchBudget =
    options.toolName === "search_archive" ||
    options.toolName === "list_archive_items" ||
    options.toolName === "search_memory";
  const searchArchiveIncrement = spendsSearchBudget ? 1 : 0;
  const resultPayload = serializeResultPayload(options.resultPayload);

  const rows = await sql`
    WITH eligible_session AS (
      SELECT id
      FROM briefing_sessions
      WHERE id = ${options.briefingSessionId}
        AND closed_at IS NULL
        AND expires_at > ${now}::timestamptz
      FOR UPDATE
    ),
    claimable_call AS (
      SELECT 1
      FROM briefing_handled_calls
      WHERE briefing_session_id = ${options.briefingSessionId}
        AND function_call_id = ${options.functionCallId}
        AND tool_name = ${options.toolName}
        AND status = 'pending'
        AND attempt_count = ${options.attemptCount}
        AND EXISTS (SELECT 1 FROM eligible_session)
      FOR UPDATE
    ),
    budget_spent AS (
      UPDATE briefing_sessions
      SET tool_call_count = tool_call_count + 1,
          search_archive_count = search_archive_count + ${searchArchiveIncrement}
      WHERE id = ${options.briefingSessionId}
        AND ${spendBudget}
        AND EXISTS (SELECT 1 FROM eligible_session)
        AND EXISTS (SELECT 1 FROM claimable_call)
        AND tool_call_count < tool_call_max
        AND (
          NOT ${spendsSearchBudget}
          OR search_archive_count < search_archive_max
        )
      RETURNING 1
    ),
    completed AS (
      UPDATE briefing_handled_calls
      SET status = 'completed',
          result_payload = ${resultPayload},
          last_error = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE briefing_session_id = ${options.briefingSessionId}
        AND function_call_id = ${options.functionCallId}
        AND tool_name = ${options.toolName}
        AND status = 'pending'
        AND attempt_count = ${options.attemptCount}
        AND EXISTS (SELECT 1 FROM eligible_session)
        AND (
          (${spendBudget} AND EXISTS (SELECT 1 FROM budget_spent))
          OR (NOT ${spendBudget} AND EXISTS (SELECT 1 FROM claimable_call))
        )
      RETURNING
        briefing_session_id,
        function_call_id,
        tool_name,
        status,
        lease_expires_at,
        attempt_count,
        last_error,
        result_payload,
        request_arguments,
        created_at,
        updated_at
    )
    SELECT
      EXISTS (SELECT 1 FROM eligible_session) AS session_eligible,
      EXISTS (SELECT 1 FROM claimable_call) AS call_claimable,
      EXISTS (SELECT 1 FROM budget_spent) AS budget_spent,
      TRUE AS completed,
      completed.briefing_session_id,
      completed.function_call_id,
      completed.tool_name,
      completed.status,
      completed.lease_expires_at,
      completed.attempt_count,
      completed.last_error,
      completed.result_payload,
      completed.request_arguments,
      completed.created_at,
      completed.updated_at
    FROM completed
    UNION ALL
    SELECT
      EXISTS (SELECT 1 FROM eligible_session) AS session_eligible,
      EXISTS (SELECT 1 FROM claimable_call) AS call_claimable,
      EXISTS (SELECT 1 FROM budget_spent) AS budget_spent,
      FALSE AS completed,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    WHERE NOT EXISTS (SELECT 1 FROM completed)
    LIMIT 1
  `;

  const row = rows[0] as CompleteHandledCallRow | undefined;
  if (!row) {
    throw new Error("Failed to complete handled call");
  }

  if (!row.session_eligible) {
    return {
      status: "session_unavailable",
      budgetSpent: row.budget_spent,
      record: null,
    } satisfies CompleteHandledCallResult;
  }

  if (!row.call_claimable) {
    return {
      status: "stale_attempt",
      budgetSpent: row.budget_spent,
      record: null,
    } satisfies CompleteHandledCallResult;
  }

  if (spendBudget && !row.budget_spent) {
    return {
      status: "budget_exhausted",
      budgetSpent: false,
      record: null,
    } satisfies CompleteHandledCallResult;
  }

  if (
    !row.completed ||
    !row.briefing_session_id ||
    !row.function_call_id ||
    !row.tool_name ||
    !row.status ||
    row.attempt_count === null ||
    !row.created_at ||
    !row.updated_at
  ) {
    return {
      status: "stale_attempt",
      budgetSpent: row.budget_spent,
      record: null,
    } satisfies CompleteHandledCallResult;
  }

  return {
    status: "completed",
    budgetSpent: row.budget_spent,
    record: mapHandledCallRow({
      briefing_session_id: row.briefing_session_id,
      function_call_id: row.function_call_id,
      tool_name: row.tool_name,
      status: row.status,
      lease_expires_at: row.lease_expires_at,
      attempt_count: row.attempt_count,
      last_error: row.last_error,
      result_payload: row.result_payload,
      request_arguments: row.request_arguments,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
  } satisfies CompleteHandledCallResult;
}

export async function failHandledCall(options: FailHandledCallOptions) {
  const rows = await sql`
    UPDATE briefing_handled_calls
    SET status = 'failed',
        last_error = ${options.lastError},
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE briefing_session_id = ${options.briefingSessionId}
      AND function_call_id = ${options.functionCallId}
      AND tool_name = ${options.toolName}
      AND status = 'pending'
      AND attempt_count = ${options.attemptCount}
    RETURNING *
  `;

  const row = rows[0] as HandledCallRow | undefined;
  if (!row) {
    return {
      status: "stale_attempt",
      record: null,
    } satisfies FailHandledCallResult;
  }

  return {
    status: "failed",
    record: mapHandledCallRow(row),
  } satisfies FailHandledCallResult;
}
