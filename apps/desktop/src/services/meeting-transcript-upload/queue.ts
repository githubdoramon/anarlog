import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { and, eq, lte, meetingTranscriptUploadQueue, or } from "@hypr/db";

import { getUnidentifiedSpeakerIds } from "./identity";
import {
  buildDigitalBrainTranscriptionPayload,
  type DigitalBrainPayloadStore,
} from "./payload";
import type {
  DigitalBrainTranscriptionPayload,
  DigitalBrainUploadStatus,
} from "./types";

import { db } from "~/db";
import { env } from "~/env";

const RETRYABLE_STATUS_CODES = new Set([408, 429]);
const PERMANENT_STATUS_CODES = new Set([400, 403, 404, 422]);
const QUEUE_POLL_INTERVAL_MS = 30 * 1000;
const MIN_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const LOG_PREFIX = "[meeting-transcript-upload]";

type QueueInput = {
  store: DigitalBrainPayloadStore;
  sessionId: string;
  currentUserEmail?: string | null;
  force?: boolean;
};

type WorkerDeps = {
  store: DigitalBrainPayloadStore;
  getAuthHeaders: () =>
    | Record<string, string>
    | null
    | Promise<Record<string, string> | null>;
  getCurrentUserEmail: () => string | null | undefined;
};

let instance: MeetingTranscriptUploadService | null = null;

export function getMeetingTranscriptUploadService() {
  return instance;
}

export async function enqueueMeetingTranscriptUpload({
  store,
  sessionId,
  currentUserEmail,
  force = false,
}: QueueInput): Promise<DigitalBrainTranscriptionPayload | null> {
  const payload = buildDigitalBrainTranscriptionPayload({
    store,
    sessionId,
    currentUserEmail,
  });
  if (!payload) {
    log("enqueue_skipped_no_payload", { sessionId, force });
    return null;
  }
  if (!hasIdentifiedSpeakers(payload)) {
    log("enqueue_skipped_unidentified_speakers", {
      sessionId,
      force,
      unresolvedSpeakers: getUnidentifiedSpeakerIds(payload),
    });
    return null;
  }

  const now = new Date().toISOString();
  const status: DigitalBrainUploadStatus = getServerUrl()
    ? "pending"
    : "config_missing";

  if (force) {
    log("enqueue_force_delete_existing", {
      sessionId,
      transcriptHash: payload.transcript_hash,
    });
    await db
      .delete(meetingTranscriptUploadQueue)
      .where(
        and(
          eq(meetingTranscriptUploadQueue.sessionId, sessionId),
          eq(
            meetingTranscriptUploadQueue.transcriptHash,
            payload.transcript_hash,
          ),
        ),
      );
  }

  if (!force) {
    const existingRows = await db
      .select()
      .from(meetingTranscriptUploadQueue)
      .where(
        and(
          eq(meetingTranscriptUploadQueue.sessionId, sessionId),
          eq(
            meetingTranscriptUploadQueue.transcriptHash,
            payload.transcript_hash,
          ),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      log("enqueue_skipped_existing", {
        sessionId,
        uploadId: payload.upload_id,
        transcriptHash: payload.transcript_hash,
        existingId: existing.id,
        existingStatus: existing.status,
        existingAttemptCount: existing.attemptCount,
        existingNextAttemptAt: existing.nextAttemptAt,
        existingSentAt: existing.sentAt,
        existingServerId: existing.serverId,
        existingLastError: truncate(existing.lastError),
      });
      return payload;
    }
  }

  await db
    .insert(meetingTranscriptUploadQueue)
    .values({
      id: payload.upload_id,
      sessionId,
      transcriptHash: payload.transcript_hash,
      payloadJson: JSON.stringify(payload),
      status,
      attemptCount: 0,
      nextAttemptAt: now,
      lastError: "",
      serverId: "",
      createdAt: now,
      updatedAt: now,
      sentAt: "",
    })
    .onConflictDoNothing({
      target: [
        meetingTranscriptUploadQueue.sessionId,
        meetingTranscriptUploadQueue.transcriptHash,
      ],
    });

  log("enqueue_complete", {
    sessionId,
    uploadId: payload.upload_id,
    transcriptHash: payload.transcript_hash,
    status,
    force,
    segmentCount: payload.transcript.segments.length,
    speakerCount: payload.speaker_identities.length,
  });

  return payload;
}

export function initMeetingTranscriptUploadService(deps: WorkerDeps) {
  instance?.dispose();
  const service = new MeetingTranscriptUploadService(deps);
  instance = service;
  service.start();
  return service;
}

export class MeetingTranscriptUploadService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private deps: WorkerDeps) {}

  start() {
    log("service_start");
    this.timer = setInterval(() => {
      void this.processNext();
    }, QUEUE_POLL_INTERVAL_MS);
    void this.processNext();
  }

  dispose() {
    log("service_dispose");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (instance === this) {
      instance = null;
    }
  }

  async enqueueSession(sessionId: string) {
    return enqueueMeetingTranscriptUpload({
      store: this.deps.store,
      sessionId,
      currentUserEmail: this.deps.getCurrentUserEmail(),
    });
  }

  async forceUploadSession(sessionId: string) {
    log("force_upload_requested", { sessionId });
    const payload = await enqueueMeetingTranscriptUpload({
      store: this.deps.store,
      sessionId,
      currentUserEmail: this.deps.getCurrentUserEmail(),
      force: true,
    });

    if (payload) {
      log("force_upload_processing_now", {
        sessionId,
        uploadId: payload.upload_id,
      });
      await this.processNext();
    }

    return payload;
  }

  scheduleSpeakerAssignmentUpload(sessionId: string | null | undefined) {
    if (!sessionId) {
      return;
    }
    void this.enqueueLatestSpeakerAssignmentUpload(sessionId);
  }

  private async enqueueLatestSpeakerAssignmentUpload(sessionId: string) {
    log("speaker_assignment_upload_enqueue_start", { sessionId });
    await this.deleteUnsentSessionRows(sessionId);
    const payload = await enqueueMeetingTranscriptUpload({
      store: this.deps.store,
      sessionId,
      currentUserEmail: this.deps.getCurrentUserEmail(),
    });
    if (!payload) {
      return;
    }

    await this.processNext();
  }

  private async deleteUnsentSessionRows(sessionId: string) {
    await db
      .delete(meetingTranscriptUploadQueue)
      .where(
        and(
          eq(meetingTranscriptUploadQueue.sessionId, sessionId),
          or(
            eq(meetingTranscriptUploadQueue.status, "pending"),
            eq(meetingTranscriptUploadQueue.status, "auth_required"),
            eq(meetingTranscriptUploadQueue.status, "config_missing"),
          ),
        ),
      );
  }

  async processNext() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.processDueRow();
    } finally {
      this.running = false;
    }
  }

  private async processDueRow() {
    const serverUrl = getServerUrl();
    if (!serverUrl) {
      log("process_skip_missing_server_url");
      return;
    }

    const now = new Date().toISOString();
    const rows = await db
      .select()
      .from(meetingTranscriptUploadQueue)
      .where(
        and(
          or(
            eq(meetingTranscriptUploadQueue.status, "pending"),
            eq(meetingTranscriptUploadQueue.status, "auth_required"),
            eq(meetingTranscriptUploadQueue.status, "config_missing"),
          ),
          or(
            eq(meetingTranscriptUploadQueue.nextAttemptAt, ""),
            lte(meetingTranscriptUploadQueue.nextAttemptAt, now),
          ),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      return;
    }

    log("process_row_start", {
      id: row.id,
      sessionId: row.sessionId,
      status: row.status,
      attemptCount: row.attemptCount,
      nextAttemptAt: row.nextAttemptAt,
    });

    const headers = await this.deps.getAuthHeaders();
    if (!headers) {
      log("process_row_missing_auth", {
        id: row.id,
        sessionId: row.sessionId,
      });
      await markRow(row.id, {
        status: "auth_required",
        lastError: "Authentication is required.",
        nextAttemptAt: nextAttemptAt(row.attemptCount),
      });
      return;
    }

    let payload: DigitalBrainTranscriptionPayload;
    try {
      payload = JSON.parse(row.payloadJson) as DigitalBrainTranscriptionPayload;
    } catch {
      log("process_row_invalid_payload_json", {
        id: row.id,
        sessionId: row.sessionId,
      });
      await markRow(row.id, {
        status: "failed",
        lastError: "Queued payload JSON is invalid.",
      });
      return;
    }

    const refreshedPayload = buildDigitalBrainTranscriptionPayload({
      store: this.deps.store,
      sessionId: row.sessionId,
      currentUserEmail: this.deps.getCurrentUserEmail(),
    });
    if (refreshedPayload?.transcript_hash === row.transcriptHash) {
      payload = refreshedPayload;
      const payloadJson = JSON.stringify(refreshedPayload);
      if (payloadJson !== row.payloadJson) {
        await db
          .update(meetingTranscriptUploadQueue)
          .set({
            payloadJson,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(meetingTranscriptUploadQueue.id, row.id));
        log("process_row_payload_refreshed", {
          id: row.id,
          sessionId: row.sessionId,
        });
      }
    }

    if (!hasIdentifiedSpeakers(payload)) {
      log("process_row_skip_unidentified_speakers", {
        id: row.id,
        sessionId: row.sessionId,
        unresolvedSpeakers: getUnidentifiedSpeakerIds(payload),
      });
      await markRow(row.id, {
        status: "pending",
        lastError: "Speaker identification is required before upload.",
        nextAttemptAt: nextAttemptAt(row.attemptCount + 1),
      });
      return;
    }

    try {
      log("post_start", {
        id: row.id,
        sessionId: row.sessionId,
        endpoint: postEndpoint(serverUrl),
        authProvider: headers["X-Auth-Provider"] ?? "app",
        segmentCount: payload.transcript.segments.length,
        speakerCount: payload.speaker_identities.length,
      });
      const response = await postPayload(serverUrl, headers, payload);
      log("post_response", {
        id: row.id,
        sessionId: row.sessionId,
        status: response.status,
        ok: response.ok,
      });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as {
          id?: unknown;
          ok?: unknown;
          server_id?: unknown;
        } | null;
        if (!body) {
          throw new Error("Server returned a successful non-JSON response.");
        }

        const serverId =
          typeof body.server_id === "string"
            ? body.server_id
            : typeof body.id === "string"
              ? body.id
              : "";

        await markRow(row.id, {
          status: "sent",
          serverId,
          sentAt: new Date().toISOString(),
          lastError: "",
        });
        log("process_row_sent", {
          id: row.id,
          sessionId: row.sessionId,
          serverId,
        });
        return;
      }

      const errorText = await response.text().catch(() => "");
      if (response.status === 401) {
        log("process_row_auth_required", {
          id: row.id,
          sessionId: row.sessionId,
          status: response.status,
          errorText: truncate(errorText),
        });
        await markRow(row.id, {
          status: "auth_required",
          lastError: errorText || "Authentication is required.",
          attemptCount: row.attemptCount + 1,
          nextAttemptAt: nextAttemptAt(row.attemptCount + 1),
        });
        return;
      }

      if (
        RETRYABLE_STATUS_CODES.has(response.status) ||
        response.status >= 500
      ) {
        log("process_row_retryable_response", {
          id: row.id,
          sessionId: row.sessionId,
          status: response.status,
          errorText: truncate(errorText),
          nextAttemptAt: nextAttemptAt(row.attemptCount + 1),
        });
        await markRow(row.id, {
          status: "pending",
          lastError: errorText || `Server returned ${response.status}.`,
          attemptCount: row.attemptCount + 1,
          nextAttemptAt: nextAttemptAt(row.attemptCount + 1),
        });
        return;
      }

      await markRow(row.id, {
        status: PERMANENT_STATUS_CODES.has(response.status)
          ? "failed"
          : "pending",
        lastError: errorText || `Server returned ${response.status}.`,
        attemptCount: row.attemptCount + 1,
        nextAttemptAt: nextAttemptAt(row.attemptCount + 1),
      });
      log("process_row_response_handled", {
        id: row.id,
        sessionId: row.sessionId,
        status: response.status,
        finalStatus: PERMANENT_STATUS_CODES.has(response.status)
          ? "failed"
          : "pending",
        errorText: truncate(errorText),
      });
    } catch (error) {
      log("post_failed", {
        id: row.id,
        sessionId: row.sessionId,
        error: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        nextAttemptAt: nextAttemptAt(row.attemptCount + 1),
      });
      await markRow(row.id, {
        status: "pending",
        lastError: error instanceof Error ? error.message : String(error),
        attemptCount: row.attemptCount + 1,
        nextAttemptAt: nextAttemptAt(row.attemptCount + 1),
      });
    }
  }
}

async function postPayload(
  serverUrl: string,
  headers: Record<string, string>,
  payload: DigitalBrainTranscriptionPayload,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await tauriFetch(postEndpoint(serverUrl), {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function markRow(
  id: string,
  values: {
    status: DigitalBrainUploadStatus;
    attemptCount?: number;
    nextAttemptAt?: string;
    lastError?: string;
    serverId?: string;
    sentAt?: string;
  },
) {
  await db
    .update(meetingTranscriptUploadQueue)
    .set({
      status: values.status,
      ...(typeof values.attemptCount === "number"
        ? { attemptCount: values.attemptCount }
        : {}),
      ...(typeof values.nextAttemptAt === "string"
        ? { nextAttemptAt: values.nextAttemptAt }
        : {}),
      ...(typeof values.lastError === "string"
        ? { lastError: values.lastError }
        : {}),
      ...(typeof values.serverId === "string"
        ? { serverId: values.serverId }
        : {}),
      ...(typeof values.sentAt === "string" ? { sentAt: values.sentAt } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(meetingTranscriptUploadQueue.id, id));
}

function nextAttemptAt(attemptCount: number) {
  const delayMs = Math.min(
    MAX_BACKOFF_MS,
    MIN_BACKOFF_MS * Math.pow(2, Math.max(0, attemptCount - 1)),
  );
  return new Date(Date.now() + delayMs).toISOString();
}

export function getServerUrl() {
  const value = env.VITE_DIGITAL_BRAIN_SERVER_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

function postEndpoint(serverUrl: string) {
  return `${serverUrl}/api/orchestrator/ingest/meetings/transcript`;
}

function hasIdentifiedSpeakers(payload: DigitalBrainTranscriptionPayload) {
  return getUnidentifiedSpeakerIds(payload).length === 0;
}

function log(event: string, data?: Record<string, unknown>) {
  if (data) {
    console.info(LOG_PREFIX, event, data);
  } else {
    console.info(LOG_PREFIX, event);
  }
}

function truncate(value: string, max = 500) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
