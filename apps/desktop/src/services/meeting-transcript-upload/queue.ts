import { and, eq, lte, meetingTranscriptUploadQueue, or } from "@hypr/db";

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
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

type QueueInput = {
  store: DigitalBrainPayloadStore;
  sessionId: string;
  currentUserEmail?: string | null;
};

type WorkerDeps = {
  store: DigitalBrainPayloadStore;
  getAuthHeaders: () => { Authorization: string } | null;
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
}: QueueInput): Promise<DigitalBrainTranscriptionPayload | null> {
  const payload = buildDigitalBrainTranscriptionPayload({
    store,
    sessionId,
    currentUserEmail,
  });
  if (!payload) {
    return null;
  }

  const now = new Date().toISOString();
  const status: DigitalBrainUploadStatus = getServerUrl()
    ? "pending"
    : "config_missing";

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
    this.timer = setInterval(() => {
      void this.processNext();
    }, 10_000);
    void this.processNext();
  }

  dispose() {
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

    const headers = this.deps.getAuthHeaders();
    if (!headers) {
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
      await markRow(row.id, {
        status: "failed",
        lastError: "Queued payload JSON is invalid.",
      });
      return;
    }

    try {
      const response = await postPayload(serverUrl, headers, payload);
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as {
          server_id?: unknown;
        } | null;
        await markRow(row.id, {
          status: "sent",
          serverId: typeof body?.server_id === "string" ? body.server_id : "",
          sentAt: new Date().toISOString(),
          lastError: "",
        });
        return;
      }

      const errorText = await response.text().catch(() => "");
      if (response.status === 401) {
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
    } catch (error) {
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
  headers: { Authorization: string },
  payload: DigitalBrainTranscriptionPayload,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(
      `${serverUrl}/api/orchestrator/ingest/events/transcription`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
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
    1000 * Math.pow(2, Math.max(0, attemptCount - 1)),
  );
  return new Date(Date.now() + delayMs).toISOString();
}

export function getServerUrl() {
  const value = env.VITE_DIGITAL_BRAIN_SERVER_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}
