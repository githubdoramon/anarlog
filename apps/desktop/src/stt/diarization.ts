import type { SpeakerHintWithId, WordWithId } from "./types";
import {
  parseTranscriptHints,
  parseTranscriptWords,
  updateTranscriptHints,
} from "./utils";

type ParticipantStore = {
  forEachRow(
    tableId: "mapping_session_participant",
    callback: (rowId: string, forEachCell: unknown) => void,
  ): void;
  getCell(
    tableId: "mapping_session_participant",
    rowId: string,
    cellId: "session_id" | "human_id" | "source",
  ): unknown;
};

type SpeakerCountStore = ParticipantStore & {
  getValue(valueId: "user_id"): unknown;
};

type TranscriptReader = {
  getCell(
    tableId: "transcripts",
    rowId: string,
    cellId: "words" | "speaker_hints",
  ): unknown;
};

type TranscriptWriter = TranscriptReader & {
  setCell(
    tableId: "transcripts",
    rowId: string,
    cellId: "words" | "speaker_hints",
    value: string,
  ): void;
};

type CompleteWord = WordWithId & {
  id: string;
  start_ms: number;
  end_ms: number;
  channel: number;
};

export function collectSessionParticipantHumanIds(
  store: ParticipantStore,
  sessionId: string,
): string[] {
  return collectSessionParticipants(store, sessionId).map(
    (participant) => participant.humanId,
  );
}

type SessionParticipant = {
  humanId: string;
  source?: string;
};

function collectSessionParticipants(
  store: ParticipantStore,
  sessionId: string,
): SessionParticipant[] {
  const participantsByHumanId = new Map<string, SessionParticipant>();

  store.forEachRow("mapping_session_participant", (mappingId, _forEachCell) => {
    const sid = store.getCell(
      "mapping_session_participant",
      mappingId,
      "session_id",
    );
    if (sid !== sessionId) {
      return;
    }

    const source = store.getCell(
      "mapping_session_participant",
      mappingId,
      "source",
    );
    if (source === "excluded") {
      return;
    }

    const humanId = store.getCell(
      "mapping_session_participant",
      mappingId,
      "human_id",
    );
    if (typeof humanId === "string" && humanId) {
      participantsByHumanId.set(humanId, {
        humanId,
        source: typeof source === "string" ? source : undefined,
      });
    }
  });

  return [...participantsByHumanId.values()];
}

export function getExpectedRemoteSpeakerCount(
  store: SpeakerCountStore,
  sessionId: string,
): number | undefined {
  const selfHumanId = store.getValue("user_id");
  const participants = collectSessionParticipants(store, sessionId);
  if (participants.length === 0) {
    return undefined;
  }

  const hasCalendarRoster = participants.some(
    (participant) => participant.source === "auto",
  );
  if (hasCalendarRoster && participants.length > 1) {
    return participants.length - 1;
  }

  const remoteParticipants = participants.filter(
    (participant) =>
      typeof selfHumanId !== "string" || participant.humanId !== selfHumanId,
  );
  return remoteParticipants.length > 0 ? remoteParticipants.length : undefined;
}

export function getBatchSpeakerBounds(
  expectedRemoteSpeakerCount: number | undefined,
):
  | {
      numSpeakers?: number;
      maxSpeakers?: number;
    }
  | undefined {
  if (!expectedRemoteSpeakerCount || expectedRemoteSpeakerCount < 1) {
    return undefined;
  }

  if (expectedRemoteSpeakerCount === 1) {
    return undefined;
  }

  return { maxSpeakers: expectedRemoteSpeakerCount };
}

export function applyProviderSpeakerCount(
  store: TranscriptWriter,
  transcriptId: string,
  channel: number,
  count: number,
): void {
  const normalizedCount = Math.max(1, Math.floor(count));
  const words = parseTranscriptWords(store, transcriptId);
  const hints = parseTranscriptHints(store, transcriptId);
  console.info("[diarization] apply provider speaker count requested", {
    transcriptId,
    channel,
    requestedCount: count,
    normalizedCount,
    wordCount: words.length,
    hintCount: hints.length,
  });
  const wordById = new Map(
    words
      .filter((word): word is CompleteWord => isCompleteWord(word))
      .map((word) => [word.id, word]),
  );
  const providerHints = hints
    .map((hint) => ({
      hint,
      data: parseProviderSpeakerHint(hint),
      word:
        typeof hint.word_id === "string"
          ? wordById.get(hint.word_id)
          : undefined,
    }))
    .filter(
      (
        entry,
      ): entry is {
        hint: SpeakerHintWithId;
        data: ProviderSpeakerHintValue;
        word: CompleteWord;
      } =>
        !!entry.data &&
        !!entry.word &&
        entry.word.channel === channel &&
        typeof entry.data.speaker_index === "number",
    );

  if (providerHints.length === 0) {
    console.info(
      "[diarization] apply provider speaker count skipped no hints",
      {
        transcriptId,
        channel,
        normalizedCount,
      },
    );
    return;
  }

  const remap = buildSpeakerIndexRemap(
    providerHints.map((entry) => ({
      speakerIndex: entry.data.speaker_index,
      startMs: entry.word.start_ms,
      durationMs: Math.max(0, entry.word.end_ms - entry.word.start_ms),
    })),
    normalizedCount,
  );
  console.info("[diarization] apply provider speaker count remap", {
    transcriptId,
    channel,
    normalizedCount,
    before: summarizeProviderHints(providerHints),
    remap: Object.fromEntries(remap),
  });

  const nextHints = hints.map((hint) => {
    const data = parseProviderSpeakerHint(hint);
    if (!data || typeof hint.word_id !== "string") {
      return hint;
    }

    const word = wordById.get(hint.word_id);
    if (!word || word.channel !== channel) {
      return hint;
    }

    const nextSpeakerIndex = remap.get(data.speaker_index);
    if (typeof nextSpeakerIndex !== "number") {
      return hint;
    }

    return {
      ...hint,
      value: JSON.stringify({
        ...data,
        channel,
        speaker_index: nextSpeakerIndex,
      }),
    };
  });

  updateTranscriptHints(store, transcriptId, nextHints);
  console.info("[diarization] apply provider speaker count wrote hints", {
    transcriptId,
    channel,
    normalizedCount,
    after: summarizeStoredProviderHints(nextHints, wordById, channel),
  });
}

export type ProviderSpeakerStat = {
  speakerIndex: number;
  wordCount: number;
  durationMs: number;
  anchorWordId: string;
  assignedHumanId?: string;
};

export type DirectMicSpeakerStat = {
  wordCount: number;
  durationMs: number;
  anchorWordId: string;
  assignedHumanId?: string;
};

const DIRECT_MIC_CHANNEL = 0;

export function getProviderSpeakerStats(
  store: TranscriptReader,
  transcriptId: string,
  channel: number,
): ProviderSpeakerStat[] {
  const words = parseTranscriptWords(store, transcriptId);
  const hints = parseTranscriptHints(store, transcriptId);
  const wordById = new Map(
    words
      .filter((word): word is CompleteWord => isCompleteWord(word))
      .map((word) => [word.id, word]),
  );
  const speakerIndexByWordId = new Map<string, number>();
  const stats = new Map<number, ProviderSpeakerStat>();

  for (const hint of hints) {
    const data = parseProviderSpeakerHint(hint);
    if (!data || typeof hint.word_id !== "string") {
      continue;
    }

    const word = wordById.get(hint.word_id);
    if (!word || word.channel !== channel) {
      continue;
    }

    speakerIndexByWordId.set(hint.word_id, data.speaker_index);
    const current = stats.get(data.speaker_index) ?? {
      speakerIndex: data.speaker_index,
      wordCount: 0,
      durationMs: 0,
      anchorWordId: hint.word_id,
    };

    current.wordCount += 1;
    current.durationMs += Math.max(0, word.end_ms - word.start_ms);
    stats.set(data.speaker_index, current);
  }

  for (const hint of hints) {
    const assignment = parseSpeakerAssignment(hint);
    if (!assignment || typeof hint.word_id !== "string") {
      continue;
    }

    if (assignment.channel !== undefined && assignment.channel !== channel) {
      continue;
    }

    const speakerIndex =
      typeof assignment.speaker_index === "number"
        ? assignment.speaker_index
        : speakerIndexByWordId.get(hint.word_id);
    if (typeof speakerIndex !== "number") {
      continue;
    }

    const stat = stats.get(speakerIndex);
    if (stat) {
      stat.assignedHumanId = assignment.human_id;
    }
  }

  return [...stats.values()].sort((left, right) => {
    if (left.speakerIndex !== right.speakerIndex) {
      return left.speakerIndex - right.speakerIndex;
    }

    return left.anchorWordId.localeCompare(right.anchorWordId);
  });
}

export function getDirectMicSpeakerStat(
  store: TranscriptReader & SpeakerCountStore,
  transcriptId: string,
): DirectMicSpeakerStat | null {
  const words = parseTranscriptWords(store, transcriptId);
  const hints = parseTranscriptHints(store, transcriptId);
  let stat: DirectMicSpeakerStat | null = null;

  for (const word of words) {
    if (!isCompleteWord(word) || word.channel !== DIRECT_MIC_CHANNEL) {
      continue;
    }

    stat ??= {
      wordCount: 0,
      durationMs: 0,
      anchorWordId: word.id,
    };
    stat.wordCount += 1;
    stat.durationMs += Math.max(0, word.end_ms - word.start_ms);
  }

  if (!stat) {
    return null;
  }

  for (const hint of hints) {
    const assignment = parseSpeakerAssignment(hint);
    if (!assignment) {
      continue;
    }
    if (
      assignment.channel === DIRECT_MIC_CHANNEL ||
      (assignment.channel === undefined && hint.word_id === stat.anchorWordId)
    ) {
      stat.assignedHumanId = assignment.human_id;
      break;
    }
  }

  const selfHumanId = store.getValue("user_id");
  stat.assignedHumanId ??=
    typeof selfHumanId === "string" ? selfHumanId : undefined;

  return stat;
}

function isCompleteWord(word: WordWithId): word is CompleteWord {
  return (
    typeof word.id === "string" &&
    typeof word.start_ms === "number" &&
    typeof word.end_ms === "number" &&
    typeof word.channel === "number"
  );
}

type ProviderSpeakerHintValue = {
  speaker_index: number;
  provider?: string;
  channel?: number;
};

function parseProviderSpeakerHint(
  hint: SpeakerHintWithId,
): ProviderSpeakerHintValue | undefined {
  if (hint.type !== "provider_speaker_index") {
    return undefined;
  }

  const value =
    typeof hint.value === "string"
      ? (() => {
          try {
            return JSON.parse(hint.value);
          } catch {
            return undefined;
          }
        })()
      : hint.value;

  if (
    value &&
    typeof value === "object" &&
    "speaker_index" in value &&
    typeof value.speaker_index === "number"
  ) {
    return value as ProviderSpeakerHintValue;
  }
}

function parseSpeakerAssignment(hint: SpeakerHintWithId):
  | {
      human_id: string;
      channel?: number;
      speaker_index?: number | null;
    }
  | undefined {
  if (
    hint.type !== "user_speaker_assignment" &&
    hint.type !== "voice_auto_assignment"
  ) {
    return undefined;
  }

  const value =
    typeof hint.value === "string"
      ? (() => {
          try {
            return JSON.parse(hint.value);
          } catch {
            return undefined;
          }
        })()
      : hint.value;

  if (
    value &&
    typeof value === "object" &&
    "human_id" in value &&
    typeof value.human_id === "string"
  ) {
    return {
      human_id: value.human_id,
      channel:
        "channel" in value && typeof value.channel === "number"
          ? value.channel
          : undefined,
      speaker_index:
        "speaker_index" in value && typeof value.speaker_index === "number"
          ? value.speaker_index
          : null,
    };
  }
}

function summarizeProviderHints(
  providerHints: Array<{
    data: ProviderSpeakerHintValue;
    word: CompleteWord;
  }>,
) {
  const bySpeaker = new Map<
    number,
    { wordCount: number; durationMs: number }
  >();
  for (const entry of providerHints) {
    const current = bySpeaker.get(entry.data.speaker_index) ?? {
      wordCount: 0,
      durationMs: 0,
    };
    current.wordCount += 1;
    current.durationMs += Math.max(0, entry.word.end_ms - entry.word.start_ms);
    bySpeaker.set(entry.data.speaker_index, current);
  }
  return Object.fromEntries(bySpeaker);
}

function summarizeStoredProviderHints(
  hints: SpeakerHintWithId[],
  wordById: Map<string, CompleteWord>,
  channel: number,
) {
  const bySpeaker = new Map<number, number>();
  for (const hint of hints) {
    const data = parseProviderSpeakerHint(hint);
    if (!data || typeof hint.word_id !== "string") {
      continue;
    }
    const word = wordById.get(hint.word_id);
    if (!word || word.channel !== channel) {
      continue;
    }
    bySpeaker.set(
      data.speaker_index,
      (bySpeaker.get(data.speaker_index) ?? 0) + 1,
    );
  }
  return Object.fromEntries(bySpeaker);
}

function buildSpeakerIndexRemap(
  entries: Array<{
    speakerIndex: number;
    startMs: number;
    durationMs: number;
  }>,
  count: number,
): Map<number, number> {
  const stats = new Map<
    number,
    {
      durationMs: number;
      weightedStartMs: number;
    }
  >();

  for (const entry of entries) {
    const current = stats.get(entry.speakerIndex) ?? {
      durationMs: 0,
      weightedStartMs: 0,
    };
    current.durationMs += entry.durationMs;
    current.weightedStartMs += entry.startMs * Math.max(1, entry.durationMs);
    stats.set(entry.speakerIndex, current);
  }

  const ranked = [...stats.entries()].sort(([, left], [, right]) =>
    right.durationMs === left.durationMs
      ? left.weightedStartMs - right.weightedStartMs
      : right.durationMs - left.durationMs,
  );
  const keep = ranked.slice(0, count).map(([speakerIndex]) => speakerIndex);
  const keepSet = new Set(keep);
  const remap = new Map<number, number>();

  keep.forEach((speakerIndex, index) => {
    remap.set(speakerIndex, index);
  });

  for (const [speakerIndex, stat] of ranked) {
    if (keepSet.has(speakerIndex)) {
      continue;
    }

    const center =
      stat.durationMs > 0 ? stat.weightedStartMs / stat.durationMs : 0;
    let nearestKept = keep[0] ?? 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const keptSpeakerIndex of keep) {
      const keptStat = stats.get(keptSpeakerIndex);
      const keptCenter =
        keptStat && keptStat.durationMs > 0
          ? keptStat.weightedStartMs / keptStat.durationMs
          : 0;
      const distance = Math.abs(center - keptCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestKept = keptSpeakerIndex;
      }
    }

    remap.set(speakerIndex, remap.get(nearestKept) ?? 0);
  }

  return remap;
}
