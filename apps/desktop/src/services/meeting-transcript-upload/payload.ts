import type { CalendarProvider, EventParticipant } from "@hypr/store";

import type {
  DigitalBrainParticipant,
  DigitalBrainSpeakerIdentity,
  DigitalBrainTranscriptionPayload,
} from "./types";

type BuildPayloadInput = {
  store: DigitalBrainPayloadStore;
  sessionId: string;
  currentUserEmail?: string | null;
};

export type DigitalBrainPayloadStore = {
  getRow: (
    tableId:
      | "sessions"
      | "transcripts"
      | "events"
      | "calendars"
      | "mapping_session_participant"
      | "humans",
    rowId: string,
  ) => any;
  getRowIds: (tableId: "events") => string[];
  getValue: (valueId: "user_id") => unknown;
  forEachRow: (
    tableId: "transcripts" | "mapping_session_participant" | "humans",
    callback: (rowId: string, forEachCell: unknown) => void,
  ) => void;
};

type SessionEvent = {
  tracking_id?: unknown;
  calendar_id?: unknown;
  title?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  description?: unknown;
};

type TranscriptWord = {
  id?: unknown;
  text?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  channel?: unknown;
};

type TranscriptJson = {
  transcripts: Array<{
    id: string;
    user_id: string;
    created_at: string;
    session_id: string;
    started_at: number;
    ended_at?: number;
    memo_md: string;
    words: unknown[];
    speaker_hints: unknown[];
  }>;
};

type SegmentChannel = "direct_mic" | "remote_party" | "mixed_capture";

type SegmentKey = {
  channel: SegmentChannel;
  speaker_index: number | null;
  human_id: string | null;
  contact_id: string | null;
  assignment_source:
    | "user_assignment"
    | "voice_auto_assignment"
    | "inferred_channel"
    | null;
};

type SegmentWord = {
  id: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
  channel: SegmentChannel;
  speaker_index: number | null;
  human_id: string | null;
  contact_id: string | null;
  assignment_source:
    | "user_assignment"
    | "voice_auto_assignment"
    | "inferred_channel"
    | null;
};

type SegmentSpeaker = {
  label: string;
  channel: SegmentChannel;
  speaker_index: number | null;
  human_id: string | null;
  contact_id: string | null;
  kind: "current_user" | "participant" | "unknown";
  email: string | null;
  name: string | null;
  source:
    | "direct_mic_self"
    | "user_assignment"
    | "voice_auto_assignment"
    | "inferred_channel"
    | "unknown";
};

type DetailedTranscriptSegment = {
  key: SegmentKey;
  speaker: SegmentSpeaker;
  started_at: string | null;
  ended_at: string | null;
  text: string;
};

type SpeakerHint = {
  word_id?: unknown;
  type?: unknown;
  value?: unknown;
};

type ProviderSpeakerHintValue = {
  channel?: unknown;
  speaker_index?: unknown;
};

type UserSpeakerAssignmentValue = {
  human_id?: unknown;
  contact_id?: unknown;
  channel?: unknown;
  speaker_index?: unknown;
};

const PROVIDERS = new Set<CalendarProvider>(["apple", "google", "outlook"]);

export function buildDigitalBrainTranscriptionPayload({
  store,
  sessionId,
  currentUserEmail,
}: BuildPayloadInput): DigitalBrainTranscriptionPayload | null {
  const transcriptJson = buildTranscriptJson(store, sessionId);
  if (!transcriptJson || transcriptJson.transcripts.length === 0) {
    return null;
  }

  const session = store.getRow("sessions", sessionId);
  const sessionEvent = parseJson<SessionEvent>(session?.event_json);
  const event = findEventForSession(store, sessionEvent);
  const provider = getProvider(store, sessionEvent, event);
  const participants = collectParticipants(store, sessionId, event);
  const meetingStartedAt = resolveMeetingStartedAt({
    session,
    sessionEvent,
    event,
    transcriptJson,
  });
  const meetingEndedAt = resolveMeetingEndedAt({
    sessionEvent,
    event,
    transcriptJson,
    meetingStartedAt,
  });
  const detailedSegments = buildDetailedTranscriptSegments({
    store,
    sessionId,
    transcriptJson,
    currentUserEmail,
  });
  if (detailedSegments.length === 0) {
    return null;
  }

  const { speakerIdentities, speakerIdByKey } =
    buildSpeakerIdentities(detailedSegments);
  const transcript = {
    segments: detailedSegments.map((segment) => ({
      speaker_id:
        speakerIdByKey.get(serializeSegmentKey(segment.key)) ?? "speaker_1",
      started_at: segment.started_at,
      ended_at: segment.ended_at,
      text: segment.text,
    })),
  };
  const meeting: DigitalBrainTranscriptionPayload["meeting"] = {
    original_id:
      provider === "google" && typeof sessionEvent?.tracking_id === "string"
        ? sessionEvent.tracking_id
        : provider == null
          ? sessionId
          : null,
    provider: provider ?? "hyprnote",
    title:
      stringOrNull(sessionEvent?.title) ?? stringOrNull(session?.title) ?? "",
    description:
      stringOrNull(sessionEvent?.description) ??
      stringOrNull(event?.description),
    started_at: meetingStartedAt,
    ended_at: meetingEndedAt,
  };
  const transcriptHash = hashString(
    stableStringify(
      buildTranscriptHashInput({
        meeting,
        speakerIdentities,
        transcript,
      }),
    ),
  );
  const uploadId = `${sessionId}:${transcriptHash}`;

  return {
    upload_id: uploadId,
    session_id: sessionId,
    transcript_hash: transcriptHash,
    meeting,
    participants,
    speaker_identities: speakerIdentities,
    transcript,
  };
}

function buildTranscriptHashInput({
  meeting,
  speakerIdentities,
  transcript,
}: {
  meeting: DigitalBrainTranscriptionPayload["meeting"];
  speakerIdentities: DigitalBrainSpeakerIdentity[];
  transcript: DigitalBrainTranscriptionPayload["transcript"];
}) {
  return {
    meeting: {
      title: meeting.title,
      original_id: meeting.original_id,
      provider: meeting.provider,
      started_at: meeting.started_at,
      ended_at: meeting.ended_at,
    },
    transcript,
    speaker_identities: speakerIdentities.map((identity) => ({
      speaker_index: identity.speaker.speaker_index,
      contact_id: identity.identity.contact_id ?? null,
    })),
  };
}

function buildTranscriptJson(
  store: DigitalBrainPayloadStore,
  sessionId: string,
): TranscriptJson | null {
  const transcripts: TranscriptJson["transcripts"] = [];

  store.forEachRow("transcripts", (transcriptId, _forEachCell) => {
    const transcript = store.getRow("transcripts", transcriptId);
    if (transcript?.session_id !== sessionId) {
      return;
    }

    const words = parseJsonArray(transcript.words);
    if (words.length === 0) {
      return;
    }

    const row = {
      id: transcriptId,
      user_id: stringOrNull(transcript.user_id) ?? "",
      created_at: stringOrNull(transcript.created_at) ?? "",
      session_id: sessionId,
      started_at:
        typeof transcript.started_at === "number" ? transcript.started_at : 0,
      memo_md: stringOrNull(transcript.memo_md) ?? "",
      words,
      speaker_hints: parseJsonArray(transcript.speaker_hints),
    };

    if (typeof transcript.ended_at === "number") {
      transcripts.push({ ...row, ended_at: transcript.ended_at });
    } else {
      transcripts.push(row);
    }
  });

  transcripts.sort((a, b) => {
    const created = a.created_at.localeCompare(b.created_at);
    return created !== 0 ? created : a.id.localeCompare(b.id);
  });

  return transcripts.length > 0 ? { transcripts } : null;
}

function findEventForSession(
  store: DigitalBrainPayloadStore,
  sessionEvent: SessionEvent | undefined,
) {
  const trackingId = stringOrNull(sessionEvent?.tracking_id);
  if (!trackingId) {
    return null;
  }

  for (const eventId of store.getRowIds("events")) {
    const event = store.getRow("events", eventId);
    if (event?.tracking_id_event === trackingId) {
      return event;
    }
  }

  return null;
}

function getProvider(
  store: DigitalBrainPayloadStore,
  sessionEvent: SessionEvent | undefined,
  event: Record<string, any> | null,
) {
  const eventProvider = stringOrNull(event?.provider);
  if (eventProvider && PROVIDERS.has(eventProvider as CalendarProvider)) {
    return eventProvider as CalendarProvider;
  }

  const calendarId = stringOrNull(sessionEvent?.calendar_id);
  const calendarProvider = calendarId
    ? stringOrNull(store.getRow("calendars", calendarId)?.provider)
    : null;

  return calendarProvider && PROVIDERS.has(calendarProvider as CalendarProvider)
    ? (calendarProvider as CalendarProvider)
    : null;
}

function resolveMeetingStartedAt({
  session,
  sessionEvent,
  event,
  transcriptJson,
}: {
  session: Record<string, any> | undefined;
  sessionEvent: SessionEvent | undefined;
  event: Record<string, any> | null;
  transcriptJson: TranscriptJson;
}) {
  return (
    isoStringOrNull(sessionEvent?.started_at) ??
    isoStringOrNull(event?.started_at) ??
    isoStringOrNull(session?.created_at) ??
    earliestTranscriptStartedAt(transcriptJson)
  );
}

function earliestTranscriptStartedAt(transcriptJson: TranscriptJson) {
  const startedAt = Math.min(
    ...transcriptJson.transcripts
      .map((transcript) => transcript.started_at)
      .filter((value) => Number.isFinite(value) && value > 0),
  );

  return Number.isFinite(startedAt)
    ? new Date(Math.round(startedAt)).toISOString()
    : null;
}

function resolveMeetingEndedAt({
  sessionEvent,
  event,
  transcriptJson,
  meetingStartedAt,
}: {
  sessionEvent: SessionEvent | undefined;
  event: Record<string, any> | null;
  transcriptJson: TranscriptJson;
  meetingStartedAt: string | null;
}) {
  const explicitEndedAt =
    isoStringOrNull(sessionEvent?.ended_at) ?? isoStringOrNull(event?.ended_at);
  if (explicitEndedAt) {
    return explicitEndedAt;
  }

  const durationMs = transcriptDurationMs(transcriptJson);
  if (durationMs != null && meetingStartedAt) {
    return new Date(Date.parse(meetingStartedAt) + durationMs).toISOString();
  }

  return latestTranscriptEndedAt(transcriptJson);
}

function transcriptDurationMs(transcriptJson: TranscriptJson) {
  let earliestStartedAt: number | null = null;
  let latestAbsoluteEndedAt: number | null = null;
  let latestRelativeEndedAt: number | null = null;

  for (const transcript of transcriptJson.transcripts) {
    const latestWordEndMs = latestWordEndOffsetMs(transcript);

    if (Number.isFinite(transcript.started_at) && transcript.started_at > 0) {
      earliestStartedAt =
        earliestStartedAt == null
          ? transcript.started_at
          : Math.min(earliestStartedAt, transcript.started_at);
      const endedAt =
        typeof transcript.ended_at === "number" && transcript.ended_at > 0
          ? transcript.ended_at
          : latestWordEndMs != null
            ? transcript.started_at + latestWordEndMs
            : null;
      if (endedAt != null) {
        latestAbsoluteEndedAt =
          latestAbsoluteEndedAt == null
            ? endedAt
            : Math.max(latestAbsoluteEndedAt, endedAt);
      }
      continue;
    }

    if (latestWordEndMs != null) {
      latestRelativeEndedAt =
        latestRelativeEndedAt == null
          ? latestWordEndMs
          : Math.max(latestRelativeEndedAt, latestWordEndMs);
    }
  }

  if (earliestStartedAt != null && latestAbsoluteEndedAt != null) {
    return Math.max(0, latestAbsoluteEndedAt - earliestStartedAt);
  }

  return latestRelativeEndedAt;
}

function latestTranscriptEndedAt(transcriptJson: TranscriptJson) {
  const endedAt = Math.max(
    ...transcriptJson.transcripts
      .map((transcript) => {
        if (
          typeof transcript.ended_at === "number" &&
          transcript.ended_at > 0
        ) {
          return transcript.ended_at;
        }

        if (
          !Number.isFinite(transcript.started_at) ||
          transcript.started_at <= 0
        ) {
          return null;
        }

        const latestWordEndMs = latestWordEndOffsetMs(transcript);

        return latestWordEndMs != null
          ? transcript.started_at + latestWordEndMs
          : null;
      })
      .filter(
        (value): value is number => value != null && Number.isFinite(value),
      ),
  );

  return Number.isFinite(endedAt)
    ? new Date(Math.round(endedAt)).toISOString()
    : null;
}

function latestWordEndOffsetMs(
  transcript: TranscriptJson["transcripts"][number],
) {
  const latestWordEndMs = Math.max(
    ...(transcript.words as TranscriptWord[])
      .map((word) => numberOrNull(word.end_ms))
      .filter((value): value is number => value != null),
  );

  return Number.isFinite(latestWordEndMs) ? latestWordEndMs : null;
}

function collectParticipants(
  store: DigitalBrainPayloadStore,
  sessionId: string,
  event: Record<string, any> | null,
): DigitalBrainParticipant[] {
  const byKey = new Map<string, DigitalBrainParticipant>();
  const add = (participant: DigitalBrainParticipant) => {
    const email = participant.email?.trim().toLowerCase();
    const key = email || `${participant.source}:${participant.name ?? ""}`;
    if (!key || byKey.has(key)) {
      return;
    }
    byKey.set(key, participant);
  };

  for (const participant of parseEventParticipants(event?.participants_json)) {
    add({
      name: stringOrNull(participant.name),
      email: stringOrNull(participant.email),
      source: "calendar",
    });
  }

  store.forEachRow("mapping_session_participant", (mappingId, _forEachCell) => {
    const mapping = store.getRow("mapping_session_participant", mappingId);
    if (
      mapping?.session_id !== sessionId ||
      mapping.source === "excluded" ||
      !mapping.human_id
    ) {
      return;
    }

    const human = store.getRow("humans", mapping.human_id);
    add({
      name: stringOrNull(human?.name),
      email: stringOrNull(human?.email),
      source: "session",
    });
  });

  return [...byKey.values()];
}

function buildDetailedTranscriptSegments({
  store,
  sessionId,
  transcriptJson,
  currentUserEmail,
}: BuildPayloadInput & {
  transcriptJson: TranscriptJson;
}): DetailedTranscriptSegment[] {
  const baseStartedAt = Math.min(
    ...transcriptJson.transcripts
      .map((transcript) => transcript.started_at)
      .filter((value) => Number.isFinite(value)),
  );
  const baseTime = Number.isFinite(baseStartedAt) ? baseStartedAt : 0;
  const selfHumanId = stringOrNull(store.getValue("user_id"));
  const speakerAssignments = buildSpeakerAssignments(
    store,
    sessionId,
    selfHumanId,
    transcriptJson,
  );
  const segments: Array<{
    key: SegmentKey;
    words: SegmentWord[];
  }> = [];

  for (const transcript of transcriptJson.transcripts) {
    const offset = transcript.started_at ? transcript.started_at - baseTime : 0;
    const words = buildSegmentWords(transcript, speakerAssignments, offset);

    for (const word of words) {
      const key: SegmentKey = {
        channel: word.channel,
        speaker_index: word.speaker_index,
        human_id: word.human_id,
        contact_id: word.contact_id,
        assignment_source: word.assignment_source,
      };
      const last = segments[segments.length - 1];
      const lastWord = last?.words[last.words.length - 1];
      const gap = word.start_ms - (lastWord?.end_ms ?? 0);

      if (last && sameSegmentKey(last.key, key) && gap <= 3000) {
        last.words.push(word);
      } else {
        segments.push({ key, words: [word] });
      }
    }
  }

  const unknownLabels = buildUnknownSpeakerLabels(
    segments.map((s) => s.key),
    {
      selfHumanId,
    },
  );

  return segments.flatMap((segment) => {
    const words = segment.words.map((word, index) => ({
      ...word,
      text: normalizeRenderedWordText(word.text, index === 0),
    }));
    const first = words[0];
    const last = words[words.length - 1];
    if (!first || !last) {
      return [];
    }

    const text = words
      .map((word) => word.text)
      .join("")
      .trim();
    if (!text) {
      return [];
    }

    return [
      {
        key: segment.key,
        speaker: buildSegmentSpeaker({
          key: segment.key,
          store,
          selfHumanId,
          currentUserEmail,
          unknownLabels,
        }),
        started_at: toIsoTime(baseTime, first.start_ms),
        ended_at: toIsoTime(baseTime, last.end_ms),
        text,
      },
    ];
  });
}

function buildSpeakerAssignments(
  store: DigitalBrainPayloadStore,
  sessionId: string,
  selfHumanId: string | null,
  transcriptJson: TranscriptJson,
) {
  const byChannel = new Map<
    SegmentChannel,
    {
      human_id: string;
      contact_id: string | null;
      source: "user_assignment" | "voice_auto_assignment" | "inferred_channel";
    }
  >();
  const byChannelSpeaker = new Map<
    string,
    {
      human_id: string;
      contact_id: string | null;
      source: "user_assignment" | "voice_auto_assignment" | "inferred_channel";
    }
  >();
  const completeChannels = new Set<SegmentChannel>(["direct_mic"]);
  const participantHumanIds = collectSessionParticipantHumanIds(
    store,
    sessionId,
  );
  const uniqueOtherParticipant =
    selfHumanId &&
    participantHumanIds.filter((humanId) => humanId && humanId !== selfHumanId);

  if (
    selfHumanId &&
    uniqueOtherParticipant &&
    uniqueOtherParticipant.length === 1
  ) {
    byChannel.set("direct_mic", {
      human_id: selfHumanId,
      contact_id: null,
      source: "inferred_channel",
    });
    byChannel.set("remote_party", {
      human_id: uniqueOtherParticipant[0],
      contact_id: null,
      source: "inferred_channel",
    });
    completeChannels.add("remote_party");
  }

  for (const transcript of transcriptJson.transcripts) {
    const wordsById = new Map<string, TranscriptWord>();
    const providerSpeakerByWordId = new Map<string, ProviderSpeakerHintValue>();

    for (const word of transcript.words as TranscriptWord[]) {
      if (typeof word.id === "string") {
        wordsById.set(word.id, word);
      }
    }

    for (const hint of transcript.speaker_hints as SpeakerHint[]) {
      if (hint.type !== "provider_speaker_index") {
        continue;
      }
      const value = parseHintValue<ProviderSpeakerHintValue>(hint.value);
      if (typeof hint.word_id === "string" && value) {
        providerSpeakerByWordId.set(hint.word_id, value);
      }
    }

    for (const hint of transcript.speaker_hints as SpeakerHint[]) {
      if (
        hint.type !== "user_speaker_assignment" &&
        hint.type !== "voice_auto_assignment"
      ) {
        continue;
      }

      const value = parseHintValue<UserSpeakerAssignmentValue>(hint.value);
      if (!value || typeof value.human_id !== "string") {
        continue;
      }

      const word =
        typeof hint.word_id === "string" ? wordsById.get(hint.word_id) : null;
      const providerSpeaker =
        typeof hint.word_id === "string"
          ? providerSpeakerByWordId.get(hint.word_id)
          : null;
      const channel = channelName(
        numberOrNull(value.channel) ??
          numberOrNull(providerSpeaker?.channel) ??
          numberOrNull(word?.channel),
      );
      const speakerIndex =
        numberOrNull(value.speaker_index) ??
        numberOrNull(providerSpeaker?.speaker_index);

      if (speakerIndex == null) {
        byChannel.set(channel, {
          human_id: value.human_id,
          contact_id: stringOrNull(value.contact_id),
          source:
            hint.type === "voice_auto_assignment"
              ? "voice_auto_assignment"
              : "user_assignment",
        });
        completeChannels.add(channel);
      } else {
        byChannelSpeaker.set(segmentSpeakerKey(channel, speakerIndex), {
          human_id: value.human_id,
          contact_id: stringOrNull(value.contact_id),
          source:
            hint.type === "voice_auto_assignment"
              ? "voice_auto_assignment"
              : "user_assignment",
        });
      }
    }
  }

  return { byChannel, byChannelSpeaker, completeChannels };
}

function collectSessionParticipantHumanIds(
  store: DigitalBrainPayloadStore,
  sessionId: string,
) {
  const humanIds: string[] = [];
  store.forEachRow("mapping_session_participant", (mappingId, _forEachCell) => {
    const mapping = store.getRow("mapping_session_participant", mappingId);
    if (
      mapping?.session_id === sessionId &&
      mapping.source !== "excluded" &&
      typeof mapping.human_id === "string" &&
      mapping.human_id
    ) {
      humanIds.push(mapping.human_id);
    }
  });
  return humanIds;
}

function buildSegmentWords(
  transcript: TranscriptJson["transcripts"][number],
  speakerAssignments: ReturnType<typeof buildSpeakerAssignments>,
  offset: number,
): SegmentWord[] {
  const words = (transcript.words as TranscriptWord[]).flatMap(
    (word): SegmentWord[] => {
      const text = stringOrNull(word.text);
      const startMs = numberOrNull(word.start_ms);
      const endMs = numberOrNull(word.end_ms);
      if (!text || startMs == null || endMs == null) {
        return [];
      }

      const channel = channelName(numberOrNull(word.channel));
      return [
        {
          id: stringOrNull(word.id),
          text,
          start_ms: Math.round(startMs + offset),
          end_ms: Math.round(endMs + offset),
          channel,
          speaker_index: null,
          human_id: null,
          contact_id: null,
          assignment_source: null,
        },
      ];
    },
  );
  const wordIndexById = new Map<string, number>();

  words.forEach((word, index) => {
    if (word.id) {
      wordIndexById.set(word.id, index);
    }
  });

  for (const hint of transcript.speaker_hints as SpeakerHint[]) {
    if (
      hint.type !== "provider_speaker_index" ||
      typeof hint.word_id !== "string"
    ) {
      continue;
    }

    const word = words[wordIndexById.get(hint.word_id) ?? -1];
    const value = parseHintValue<ProviderSpeakerHintValue>(hint.value);
    if (!word || !value) {
      continue;
    }

    word.channel = channelName(
      numberOrNull(value.channel) ?? channelNumber(word.channel),
    );
    word.speaker_index = numberOrNull(value.speaker_index);
  }

  for (const word of words) {
    const scopedAssignment =
      word.speaker_index == null
        ? null
        : speakerAssignments.byChannelSpeaker.get(
            segmentSpeakerKey(word.channel, word.speaker_index),
          );
    const channelAssignment = speakerAssignments.completeChannels.has(
      word.channel,
    )
      ? speakerAssignments.byChannel.get(word.channel)
      : null;
    const assignment = scopedAssignment ?? channelAssignment ?? null;
    word.human_id = assignment?.human_id ?? null;
    word.contact_id = assignment?.contact_id ?? null;
    word.assignment_source = assignment?.source ?? null;
  }

  return words.sort((a, b) => {
    const start = a.start_ms - b.start_ms;
    return start !== 0 ? start : a.end_ms - b.end_ms;
  });
}

function buildSegmentSpeaker({
  key,
  store,
  selfHumanId,
  currentUserEmail,
  unknownLabels,
}: {
  key: SegmentKey;
  store: DigitalBrainPayloadStore;
  selfHumanId: string | null;
  currentUserEmail?: string | null;
  unknownLabels: Map<string, string>;
}): SegmentSpeaker {
  const humanId = key.human_id ?? selfHumanId;
  const human = humanId ? store.getRow("humans", humanId) : null;
  const isCurrentUser =
    key.human_id === selfHumanId ||
    (!key.human_id &&
      key.channel === "direct_mic" &&
      key.speaker_index == null &&
      !!selfHumanId);

  if (isCurrentUser) {
    return {
      label: "You",
      channel: key.channel,
      speaker_index: key.speaker_index,
      human_id: key.human_id ?? selfHumanId,
      contact_id: key.contact_id,
      kind: "current_user",
      email: currentUserEmail ?? stringOrNull(human?.email),
      name: stringOrNull(human?.name),
      source: "direct_mic_self",
    };
  }

  if (key.human_id) {
    return {
      label: stringOrNull(human?.name) ?? key.human_id,
      channel: key.channel,
      speaker_index: key.speaker_index,
      human_id: key.human_id,
      contact_id: key.contact_id,
      kind: "participant",
      email: stringOrNull(human?.email),
      name: stringOrNull(human?.name),
      source:
        key.assignment_source ??
        (key.speaker_index == null ? "inferred_channel" : "user_assignment"),
    };
  }

  return {
    label: unknownLabels.get(serializeSegmentKey(key)) ?? "Speaker",
    channel: key.channel,
    speaker_index: key.speaker_index,
    human_id: null,
    contact_id: null,
    kind: "unknown",
    email: null,
    name: null,
    source: "unknown",
  };
}

function buildSpeakerIdentities(segments: DetailedTranscriptSegment[]) {
  const speakerIdentities: DigitalBrainSpeakerIdentity[] = [];
  const speakerIdByKey = new Map<string, string>();

  for (const segment of segments) {
    const key = serializeSegmentKey(segment.key);
    if (speakerIdByKey.has(key)) {
      continue;
    }

    const id = `speaker_${speakerIdentities.length + 1}`;
    speakerIdByKey.set(key, id);
    speakerIdentities.push({
      id,
      label: segment.speaker.label,
      speaker: {
        channel: segment.speaker.channel,
        speaker_index: segment.speaker.speaker_index,
      },
      identity: {
        kind: segment.speaker.kind,
        contact_id: segment.speaker.contact_id,
        email: segment.speaker.email,
        name: segment.speaker.name,
      },
      source: segment.speaker.source,
    });
  }

  return { speakerIdentities, speakerIdByKey };
}

function buildUnknownSpeakerLabels(
  keys: SegmentKey[],
  {
    selfHumanId,
  }: {
    selfHumanId: string | null;
  },
) {
  const labels = new Map<string, string>();
  let next = 1;

  for (const key of keys) {
    if (key.human_id) {
      continue;
    }
    if (
      key.channel === "direct_mic" &&
      key.speaker_index == null &&
      selfHumanId
    ) {
      continue;
    }

    const serialized = serializeSegmentKey(key);
    if (!labels.has(serialized)) {
      labels.set(serialized, `Speaker ${next}`);
      next += 1;
    }
  }

  return labels;
}

function sameSegmentKey(a: SegmentKey, b: SegmentKey) {
  return (
    a.channel === b.channel &&
    a.speaker_index === b.speaker_index &&
    a.human_id === b.human_id &&
    a.contact_id === b.contact_id &&
    a.assignment_source === b.assignment_source
  );
}

function segmentSpeakerKey(channel: SegmentChannel, speakerIndex: number) {
  return `${channel}:${speakerIndex}`;
}

function serializeSegmentKey(key: SegmentKey) {
  return `${key.channel}:${key.speaker_index ?? "null"}:${key.human_id ?? "null"}:${key.contact_id ?? "null"}:${key.assignment_source ?? "null"}`;
}

function normalizeRenderedWordText(text: string, isFirstWord: boolean) {
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return text;
  }
  if (isFirstWord) {
    return trimmedStart;
  }
  if (text.startsWith(" ")) {
    return text;
  }
  if (/^[,.;:!?)}\]'"]/.test(trimmedStart)) {
    return trimmedStart;
  }
  return ` ${trimmedStart}`;
}

function toIsoTime(baseStartedAt: number, offsetMs: number) {
  if (!baseStartedAt) {
    return null;
  }
  return new Date(baseStartedAt + offsetMs).toISOString();
}

function parseEventParticipants(value: unknown): EventParticipant[] {
  const parsed = parseJson<unknown>(value);
  return Array.isArray(parsed) ? (parsed as EventParticipant[]) : [];
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJson<unknown>(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function parseHintValue<T>(value: unknown): T | undefined {
  if (typeof value === "string") {
    return parseJson<T>(value);
  }
  return value && typeof value === "object" ? (value as T) : undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isoStringOrNull(value: unknown): string | null {
  const text = stringOrNull(value);
  if (!text) {
    return null;
  }

  return Number.isNaN(Date.parse(text)) ? null : text;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function channelName(value: number | null | undefined) {
  return value === 0
    ? "direct_mic"
    : value === 1
      ? "remote_party"
      : "mixed_capture";
}

function channelNumber(value: SegmentChannel) {
  return value === "direct_mic" ? 0 : value === "remote_party" ? 1 : 2;
}
