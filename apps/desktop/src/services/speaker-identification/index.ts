import { commands as transcriptionCommands } from "@hypr/plugin-transcription";
import type { SpeakerHintStorage } from "@hypr/store";

import type { DigitalBrainSpeakerIdentity } from "~/services/meeting-transcript-upload";
import { getServerUrl } from "~/services/meeting-transcript-upload";
import {
  buildDigitalBrainTranscriptionPayload,
  type DigitalBrainPayloadStore,
} from "~/services/meeting-transcript-upload/payload";
import { id } from "~/shared/utils";

type WorkerDeps = {
  store: DigitalBrainPayloadStore;
  getAuthHeaders: () => { Authorization: string } | null;
  getCurrentUserEmail: () => string | null | undefined;
};

type VoiceEmbeddingWindow = {
  id: string;
  speaker_id: string;
  start_ms: number;
  end_ms: number;
  channel: number;
  speaker_index?: number | null;
  word_count?: number | null;
};

type VoiceEmbeddingObservation = {
  id: string;
  speaker_id: string;
  embedding: number[];
  embedding_model: string;
  embedding_dim: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  channel: number;
  speaker_index?: number | null;
  word_count?: number | null;
};

type SpeakerMatchResponse = {
  status: "done" | "processing" | "failed";
  retry_after_ms?: number | null;
  assignments?: Array<{
    speaker_id: string;
    action: "auto_label" | "suggest" | "none";
    candidate?: {
      contact_id: string;
      name?: string | null;
      email?: string | null;
      score: number;
      margin?: number | null;
      confidence: string;
      is_participant?: boolean;
    } | null;
    alternates?: Array<{
      contact_id: string;
      name?: string | null;
      email?: string | null;
      score: number;
      margin?: number | null;
      confidence: string;
      is_participant?: boolean;
    }>;
    reason?: string | null;
  }>;
};

type TranscriptWord = {
  id?: unknown;
  text?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  channel?: unknown;
};

type StoredSpeakerHint = Omit<SpeakerHintStorage, "type"> & {
  id?: string;
  type?: string;
};

type SpeakerAnchor = {
  transcriptId: string;
  wordId: string;
  hints: StoredSpeakerHint[];
  words: TranscriptWord[];
};

const MIN_WINDOW_MS = 6000;
const MAX_WINDOW_MS = 15000;
const TARGET_WINDOWS_PER_SPEAKER = 5;
const MAX_WINDOWS_PER_SPEAKER = 8;
const MATCH_WAIT_BUDGET_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 1500;

let instance: SpeakerIdentificationService | null = null;

export function initSpeakerIdentificationService(deps: WorkerDeps) {
  instance = new SpeakerIdentificationService(deps);
  return instance;
}

export function getSpeakerIdentificationService() {
  return instance;
}

export class SpeakerIdentificationService {
  constructor(private deps: WorkerDeps) {}

  dispose() {
    if (instance === this) {
      instance = null;
    }
  }

  async matchAndApplyBeforeEnhance(
    sessionId: string,
    audioPath: string | null,
  ) {
    const serverUrl = getServerUrl();
    const headers = this.deps.getAuthHeaders();
    if (!serverUrl || !headers || !audioPath) {
      return null;
    }

    const payload = buildDigitalBrainTranscriptionPayload({
      store: this.deps.store,
      sessionId,
      currentUserEmail: this.deps.getCurrentUserEmail(),
    });
    if (!payload) {
      return null;
    }

    const baseStartedAt = getBaseTranscriptStartedAt(
      this.deps.store,
      sessionId,
    );
    if (!baseStartedAt) {
      return null;
    }

    const windows = buildEmbeddingWindows(
      payload.speaker_identities,
      payload.transcript.segments,
      baseStartedAt,
    );
    if (windows.length === 0) {
      return null;
    }

    let observations: VoiceEmbeddingObservation[];
    try {
      const result = await transcriptionCommands.extractVoiceEmbeddings(
        audioPath,
        windows,
      );
      if (result.status === "error") {
        console.info("[speaker-id] voice embedding extraction skipped", {
          sessionId,
          error: result.error,
        });
        return null;
      }
      observations = result.data as VoiceEmbeddingObservation[];
    } catch (error) {
      console.info("[speaker-id] voice embedding extraction failed", {
        sessionId,
        error,
      });
      return null;
    }

    const speakerObservations = buildSpeakerObservationPayload(
      observations,
      baseStartedAt,
    );
    if (speakerObservations.length === 0) {
      return null;
    }

    const match = await postMatchWithRetry(serverUrl, headers, {
      session_id: sessionId,
      participants: payload.participants,
      speaker_observations: speakerObservations,
    });
    if (!match || match.status !== "done") {
      return match;
    }

    applyAutoAssignments(
      this.deps.store,
      sessionId,
      payload.speaker_identities,
      match.assignments ?? [],
    );
    return match;
  }
}

function getBaseTranscriptStartedAt(
  store: DigitalBrainPayloadStore,
  sessionId: string,
) {
  let base: number | null = null;
  store.forEachRow("transcripts", (transcriptId) => {
    const transcript = store.getRow("transcripts", transcriptId);
    if (transcript?.session_id !== sessionId) {
      return;
    }
    if (typeof transcript.started_at !== "number") {
      return;
    }
    base =
      base == null
        ? transcript.started_at
        : Math.min(base, transcript.started_at);
  });
  return base;
}

function buildEmbeddingWindows(
  speakerIdentities: DigitalBrainSpeakerIdentity[],
  segments: Array<{
    speaker_id: string;
    started_at: string | null;
    ended_at: string | null;
    text: string;
  }>,
  baseStartedAt: number,
): VoiceEmbeddingWindow[] {
  const speakerById = new Map(
    speakerIdentities.map((speaker) => [speaker.id, speaker]),
  );
  const bySpeaker = new Map<string, VoiceEmbeddingWindow[]>();

  for (const segment of segments) {
    if (!segment.started_at || !segment.ended_at) {
      continue;
    }
    const startedAt = Date.parse(segment.started_at);
    const endedAt = Date.parse(segment.ended_at);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
      continue;
    }
    const durationMs = endedAt - startedAt;
    if (durationMs < MIN_WINDOW_MS) {
      continue;
    }

    const speaker = speakerById.get(segment.speaker_id);
    const channel = channelNumber(speaker?.speaker.channel);
    const startMs = Math.max(0, Math.round(startedAt - baseStartedAt));
    const endMs = startMs + Math.min(durationMs, MAX_WINDOW_MS);
    const window: VoiceEmbeddingWindow = {
      id: id(),
      speaker_id: segment.speaker_id,
      start_ms: startMs,
      end_ms: endMs,
      channel,
      speaker_index: speaker?.speaker.speaker_index ?? null,
      word_count: segment.text.trim().split(/\s+/).filter(Boolean).length,
    };
    const existing = bySpeaker.get(segment.speaker_id) ?? [];
    existing.push(window);
    bySpeaker.set(segment.speaker_id, existing);
  }

  return [...bySpeaker.values()].flatMap((speakerWindows) =>
    selectSpreadWindows(speakerWindows, TARGET_WINDOWS_PER_SPEAKER).slice(
      0,
      MAX_WINDOWS_PER_SPEAKER,
    ),
  );
}

function selectSpreadWindows(
  windows: VoiceEmbeddingWindow[],
  targetCount: number,
) {
  if (windows.length <= targetCount) {
    return windows;
  }
  const selected: VoiceEmbeddingWindow[] = [];
  const step = (windows.length - 1) / (targetCount - 1);
  for (let index = 0; index < targetCount; index++) {
    selected.push(windows[Math.round(index * step)]);
  }
  return selected;
}

function buildSpeakerObservationPayload(
  observations: VoiceEmbeddingObservation[],
  baseStartedAt: number,
) {
  const bySpeaker = new Map<string, VoiceEmbeddingObservation[]>();
  for (const observation of observations) {
    const existing = bySpeaker.get(observation.speaker_id) ?? [];
    existing.push(observation);
    bySpeaker.set(observation.speaker_id, existing);
  }

  return [...bySpeaker.entries()].map(([speakerId, speakerObservations]) => {
    const first = speakerObservations[0];
    return {
      speaker_id: speakerId,
      embeddings: speakerObservations.map(
        (observation) => observation.embedding,
      ),
      embedding_model: first.embedding_model,
      embedding_dim: first.embedding_dim,
      windows: speakerObservations.map((observation) => ({
        id: observation.id,
        started_at: new Date(
          baseStartedAt + observation.start_ms,
        ).toISOString(),
        ended_at: new Date(baseStartedAt + observation.end_ms).toISOString(),
        duration_ms: observation.duration_ms,
        channel: channelName(observation.channel),
        speaker_index: observation.speaker_index ?? null,
        word_count: observation.word_count ?? null,
      })),
      context: {
        channel: channelName(first.channel),
        speaker_index: first.speaker_index ?? null,
      },
    };
  });
}

async function postMatchWithRetry(
  serverUrl: string,
  headers: { Authorization: string },
  body: unknown,
) {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt <= MATCH_WAIT_BUDGET_MS) {
    attempt += 1;
    const response = await fetch(
      `${serverUrl}/api/orchestrator/meetings/speakers/match`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      console.info("[speaker-id] backend match failed", {
        status: response.status,
        attempt,
      });
      return null;
    }
    const result = (await response.json()) as SpeakerMatchResponse;
    if (result.status !== "processing") {
      return result;
    }
    const retryAfter = Math.max(
      250,
      result.retry_after_ms ?? DEFAULT_RETRY_AFTER_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, retryAfter));
  }
  return { status: "processing" } satisfies SpeakerMatchResponse;
}

function applyAutoAssignments(
  store: DigitalBrainPayloadStore,
  sessionId: string,
  speakerIdentities: DigitalBrainSpeakerIdentity[],
  assignments: NonNullable<SpeakerMatchResponse["assignments"]>,
) {
  const speakerById = new Map(
    speakerIdentities.map((speaker) => [speaker.id, speaker]),
  );
  for (const assignment of assignments) {
    if (assignment.action !== "auto_label" || !assignment.candidate) {
      continue;
    }
    const speaker = speakerById.get(assignment.speaker_id);
    if (!speaker) {
      continue;
    }
    const humanId = findOrCreateHuman(store, assignment.candidate);
    if (!humanId) {
      continue;
    }
    applyVoiceAutoAssignmentHint(store, sessionId, speaker, humanId);
  }
}

function findOrCreateHuman(
  store: DigitalBrainPayloadStore,
  candidate: NonNullable<
    NonNullable<SpeakerMatchResponse["assignments"]>[number]["candidate"]
  >,
) {
  const email = candidate.email?.trim().toLowerCase();
  let found: string | null = null;
  if (email) {
    store.forEachRow("humans", (humanId) => {
      const human = store.getRow("humans", humanId);
      if (
        typeof human?.email === "string" &&
        human.email.toLowerCase() === email
      ) {
        found = humanId;
      }
    });
  }
  if (found) {
    return found;
  }

  const setter = store as DigitalBrainPayloadStore & {
    setRow?: (
      tableId: "humans",
      rowId: string,
      row: Record<string, unknown>,
    ) => void;
  };
  if (!setter.setRow) {
    return null;
  }

  const humanId = id();
  setter.setRow("humans", humanId, {
    user_id: String(store.getValue("user_id") ?? ""),
    name: candidate.name || candidate.email || candidate.contact_id,
    email: candidate.email ?? "",
    org_id: "",
    job_title: "",
    linkedin_username: "",
    memo: "",
    pinned: false,
  });
  return humanId;
}

function applyVoiceAutoAssignmentHint(
  store: DigitalBrainPayloadStore,
  sessionId: string,
  speaker: DigitalBrainSpeakerIdentity,
  humanId: string,
) {
  const anchor = findAnchorWord(store, sessionId, speaker);
  if (!anchor) {
    return;
  }
  const { transcriptId, wordId, hints, words } = anchor;
  const nextScope = {
    channel: channelNumber(speaker.speaker.channel),
    speakerIndex: speaker.speaker.speaker_index ?? null,
  };
  if (hasConflictingUserAssignment(hints, words, nextScope)) {
    return;
  }

  const nextHints = hints.filter((hint) => {
    if (hint.type !== "voice_auto_assignment") {
      return true;
    }
    const scope = assignmentScopeForHint(hints, words, hint);
    return !scope || !scopesConflict(scope, nextScope);
  });
  nextHints.push({
    id: `${wordId}:voice_auto_assignment`,
    word_id: wordId,
    type: "voice_auto_assignment",
    value: JSON.stringify({
      human_id: humanId,
      channel: nextScope.channel,
      speaker_index: nextScope.speakerIndex,
    }),
  });
  updateTranscriptHints(store, transcriptId, nextHints);
}

function findAnchorWord(
  store: DigitalBrainPayloadStore,
  sessionId: string,
  speaker: DigitalBrainSpeakerIdentity,
): SpeakerAnchor | null {
  const channel = channelNumber(speaker.speaker.channel);
  const speakerIndex = speaker.speaker.speaker_index ?? null;
  let found: SpeakerAnchor | null = null;
  store.forEachRow("transcripts", (transcriptId) => {
    if (found) {
      return;
    }
    const transcript = store.getRow("transcripts", transcriptId);
    if (transcript?.session_id !== sessionId) {
      return;
    }
    const words = parseJsonArray<TranscriptWord>(transcript.words);
    const hints = parseJsonArray<StoredSpeakerHint>(transcript.speaker_hints);
    for (const word of words) {
      const wordId = typeof word.id === "string" ? word.id : null;
      if (!wordId || numberOrNull(word.channel) !== channel) {
        continue;
      }
      if (
        speakerIndex != null &&
        providerSpeakerIndexForWord(hints, wordId) !== speakerIndex
      ) {
        continue;
      }
      found = { transcriptId, wordId, hints, words };
      return;
    }
  });
  return found;
}

function hasConflictingUserAssignment(
  hints: StoredSpeakerHint[],
  words: TranscriptWord[],
  scope: { channel: number; speakerIndex: number | null },
) {
  return hints.some((hint) => {
    if (hint.type !== "user_speaker_assignment") {
      return false;
    }
    const hintScope = assignmentScopeForHint(hints, words, hint);
    return !!hintScope && scopesConflict(hintScope, scope);
  });
}

function assignmentScopeForHint(
  hints: StoredSpeakerHint[],
  words: TranscriptWord[],
  hint: StoredSpeakerHint,
) {
  const value = parseHintValue(hint.value);
  if (value && typeof value === "object") {
    const channel = numberOrNull((value as { channel?: unknown }).channel);
    const speakerIndex = numberOrNull(
      (value as { speaker_index?: unknown }).speaker_index,
    );
    if (channel != null) {
      return { channel, speakerIndex };
    }
  }
  const wordId = typeof hint.word_id === "string" ? hint.word_id : null;
  const word = wordId
    ? words.find((candidate) => candidate.id === wordId)
    : null;
  const channel = numberOrNull(word?.channel);
  if (channel == null || !wordId) {
    return null;
  }
  return { channel, speakerIndex: providerSpeakerIndexForWord(hints, wordId) };
}

function scopesConflict(
  left: { channel: number; speakerIndex: number | null },
  right: { channel: number; speakerIndex: number | null },
) {
  return (
    left.channel === right.channel &&
    (left.speakerIndex == null ||
      right.speakerIndex == null ||
      left.speakerIndex === right.speakerIndex)
  );
}

function providerSpeakerIndexForWord(
  hints: StoredSpeakerHint[],
  wordId: string,
) {
  const hint = hints.find(
    (candidate) =>
      candidate.type === "provider_speaker_index" &&
      candidate.word_id === wordId,
  );
  const value = parseHintValue(hint?.value);
  return value && typeof value === "object"
    ? numberOrNull((value as { speaker_index?: unknown }).speaker_index)
    : null;
}

function updateTranscriptHints(
  store: DigitalBrainPayloadStore,
  transcriptId: string,
  hints: StoredSpeakerHint[],
) {
  const setter = store as DigitalBrainPayloadStore & {
    setCell?: (
      tableId: "transcripts",
      rowId: string,
      cellId: "speaker_hints",
      value: string,
    ) => void;
  };
  setter.setCell?.(
    "transcripts",
    transcriptId,
    "speaker_hints",
    JSON.stringify(hints),
  );
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseHintValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function channelNumber(channel: string | undefined) {
  if (channel === "remote_party") return 1;
  if (channel === "mixed_capture") return 2;
  return 0;
}

function channelName(channel: number) {
  if (channel === 1) return "remote_party";
  if (channel === 2) return "mixed_capture";
  return "direct_mic";
}
