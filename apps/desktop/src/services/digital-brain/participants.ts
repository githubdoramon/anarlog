import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type {
  EventParticipant,
  HumanStorage,
  MappingSessionParticipantStorage,
} from "@hypr/store";

import { getServerUrl } from "~/services/meeting-transcript-upload/queue";
import { getSessionEventById } from "~/session/utils";
import { DEFAULT_USER_ID, id } from "~/shared/utils";
import { parseTranscriptWords, upsertSpeakerAssignment } from "~/stt/utils";

type ParticipantEnrichmentStore = Parameters<typeof getSessionEventById>[0] & {
  getValue(valueId: "user_id"): unknown;
  getCell(
    tableId: "transcripts",
    rowId: string,
    cellId: "words" | "speaker_hints",
  ): unknown;
  setCell(
    tableId: "transcripts",
    rowId: string,
    cellId: "words" | "speaker_hints",
    value: string,
  ): void;
  transaction(callback: () => void): void;
  setRow(
    tableId: "mapping_session_participant",
    rowId: string,
    row: MappingSessionParticipantStorage,
  ): void;
  setRow(tableId: "humans", rowId: string, row: HumanStorage): void;
  setPartialRow(
    tableId: "humans",
    rowId: string,
    row: Partial<HumanStorage>,
  ): void;
  delRow(tableId: "mapping_session_participant", rowId: string): void;
};

const REQUEST_TIMEOUT_MS = 10 * 1000;
const PARTICIPANTS_RESOLVE_PATH = "/api/orchestrator/participants/resolve";

type DigitalBrainParticipantInfo = {
  contactId: string | null;
  name: string | null;
  aliases: string[];
  emails: string[];
  isCurrentUser: boolean;
};

type EnrichInput = {
  store: ParticipantEnrichmentStore;
  sessionId: string;
  authHeaders: { Authorization: string } | null;
  currentUserEmail?: string | null;
};

export async function enrichSessionParticipantsFromDigitalBrain({
  store,
  sessionId,
  authHeaders,
  currentUserEmail,
}: EnrichInput): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl || !authHeaders) {
    console.info("[digital-brain] participant_enrichment_skipped", {
      session_id: sessionId,
      has_server_url: !!serverUrl,
      server_url: serverUrl,
      has_auth_headers: !!authHeaders,
      current_user_email: currentUserEmail ?? null,
    });
    return;
  }

  const participants = collectSessionParticipantCandidates(
    store,
    sessionId,
    currentUserEmail,
  );
  if (participants.length === 0) {
    console.info("[digital-brain] participant_enrichment_skipped", {
      session_id: sessionId,
      reason: "no_participants",
      current_user_email: currentUserEmail ?? null,
    });
    return;
  }

  console.info("[digital-brain] participant_enrichment_request", {
    session_id: sessionId,
    server_url: serverUrl,
    path: PARTICIPANTS_RESOLVE_PATH,
    current_user_email: currentUserEmail ?? null,
    participant_count: participants.length,
  });

  let participantInfo: DigitalBrainParticipantInfo[];
  try {
    participantInfo = await fetchParticipantInfo(serverUrl, authHeaders, {
      session_id: sessionId,
      current_user_email: currentUserEmail ?? null,
      participants,
    });
  } catch (error) {
    console.warn(
      "[digital-brain] failed to enrich participants",
      serializeError(error),
    );
    return;
  }

  console.info("[digital-brain] participant_enrichment_response", {
    session_id: sessionId,
    participant_count: participantInfo.length,
  });

  applyParticipantInfo(store, sessionId, participantInfo, currentUserEmail);
}

function collectSessionParticipantCandidates(
  store: ParticipantEnrichmentStore,
  sessionId: string,
  currentUserEmail?: string | null,
) {
  const byEmail = new Map<
    string,
    {
      name: string | null;
      email: string;
    }
  >();
  const add = (name: unknown, email: unknown) => {
    if (typeof email !== "string" || !email.trim()) {
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || byEmail.has(normalizedEmail)) {
      return;
    }

    byEmail.set(normalizedEmail, {
      name: typeof name === "string" && name.trim() ? name.trim() : null,
      email: email.trim(),
    });
  };

  const sessionEvent = getSessionEventById(store, sessionId);
  const trackingId = sessionEvent?.tracking_id;
  if (trackingId) {
    store.forEachRow("events", (eventId, _forEachCell) => {
      const event = store.getRow("events", eventId);
      if (event?.tracking_id_event !== trackingId) {
        return;
      }

      for (const participant of parseEventParticipants(
        event.participants_json,
      )) {
        add(participant.name, participant.email);
      }
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
    add(human?.name, human?.email);
  });

  add(null, currentUserEmail);

  return [...byEmail.values()];
}

function parseEventParticipants(value: unknown): EventParticipant[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchParticipantInfo(
  serverUrl: string,
  authHeaders: { Authorization: string },
  payload: {
    session_id: string;
    current_user_email: string | null;
    participants: Array<{ name: string | null; email: string }>;
  },
) {
  const response = await postResolveRequest(serverUrl, authHeaders, payload);
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.warn("[digital-brain] participant_enrichment_http_error", {
      status: response.status,
      body: truncateLog(errorText),
    });
    throw new Error(`server returned ${response.status}: ${errorText}`);
  }

  const body = await response.json().catch(() => null);
  return parseParticipantInfoResponse(body);
}

async function postResolveRequest(
  serverUrl: string,
  authHeaders: { Authorization: string },
  payload: {
    session_id: string;
    current_user_email: string | null;
    participants: Array<{ name: string | null; email: string }>;
  },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await tauriFetch(
      `${serverUrl}${PARTICIPANTS_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    console.info("[digital-brain] participant_enrichment_http_response", {
      path: PARTICIPANTS_RESOLVE_PATH,
      status: response.status,
      ok: response.ok,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function parseParticipantInfoResponse(
  body: unknown,
): DigitalBrainParticipantInfo[] {
  const rawItems =
    body && typeof body === "object"
      ? "participants" in body
        ? (body as { participants?: unknown }).participants
        : "people" in body
          ? (body as { people?: unknown }).people
          : body
      : body;

  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const emails = uniqueNormalized([
        ...readStringArray(record.emails),
        ...readStringArray(record.email_addresses),
        record.email,
        record.primary_email,
      ]);
      if (emails.length === 0) {
        return null;
      }

      return {
        contactId: readString(record.contact_id),
        name: readString(record.name) ?? readString(record.display_name),
        aliases: uniqueStrings([
          ...readStringArray(record.aliases),
          ...readStringArray(record.names),
        ]),
        emails,
        isCurrentUser:
          record.is_current_user === true ||
          record.isCurrentUser === true ||
          record.relationship === "self",
      } satisfies DigitalBrainParticipantInfo;
    })
    .filter((item): item is DigitalBrainParticipantInfo => !!item);
}

function applyParticipantInfo(
  store: ParticipantEnrichmentStore,
  sessionId: string,
  participantInfo: DigitalBrainParticipantInfo[],
  currentUserEmail?: string | null,
) {
  if (participantInfo.length === 0) {
    return;
  }

  const humansByEmail = buildHumansByEmailIndex(store);
  const existingMappings = getSessionMappings(store, sessionId);
  const mappedHumanIds = new Set(
    existingMappings
      .filter((mapping) => mapping.source !== "excluded")
      .map((mapping) => mapping.humanId),
  );
  const currentUserEmailNormalized = normalizeEmail(currentUserEmail);
  const userId = String(store.getValue("user_id") || DEFAULT_USER_ID);

  store.transaction(() => {
    for (const info of participantInfo) {
      const isCurrentUser =
        info.isCurrentUser ||
        (!!currentUserEmailNormalized &&
          info.emails.includes(currentUserEmailNormalized));
      const humanId = isCurrentUser
        ? userId
        : findOrCreateHuman(store, humansByEmail, info, userId);

      if (isCurrentUser) {
        upsertCurrentUserHuman(store, userId, info, currentUserEmail);
        seedCurrentUserSpeakerAssignment(store, sessionId, userId, info);
        for (const email of info.emails) {
          humansByEmail.set(email, userId);
        }
      }

      if (!mappedHumanIds.has(humanId)) {
        const excluded = existingMappings.some(
          (mapping) =>
            mapping.source === "excluded" && mapping.humanId === humanId,
        );
        if (!excluded) {
          store.setRow("mapping_session_participant", id(), {
            user_id: userId,
            session_id: sessionId,
            human_id: humanId,
            source: "auto",
          } satisfies MappingSessionParticipantStorage);
          mappedHumanIds.add(humanId);
        }
      }

      for (const mapping of existingMappings) {
        if (
          mapping.source === "auto" &&
          mapping.humanId !== humanId &&
          info.emails.includes(mapping.email)
        ) {
          store.delRow("mapping_session_participant", mapping.id);
          mappedHumanIds.delete(mapping.humanId);
        }
      }
    }
  });
}

function seedCurrentUserSpeakerAssignment(
  store: ParticipantEnrichmentStore,
  sessionId: string,
  userId: string,
  info: DigitalBrainParticipantInfo,
) {
  const contactId = info.contactId?.trim();
  if (!contactId) {
    return;
  }

  store.forEachRow("transcripts", (transcriptId, _forEachCell) => {
    const transcript = store.getRow("transcripts", transcriptId);
    if (transcript?.session_id !== sessionId) {
      return;
    }

    const anchorWord = parseTranscriptWords(store, transcriptId).find(
      (word) => word.channel === 0,
    );
    if (!anchorWord?.id) {
      return;
    }

    upsertSpeakerAssignment(
      store,
      transcriptId,
      {
        channel: "DirectMic",
        speaker_index: null,
        speaker_human_id: null,
      },
      userId,
      anchorWord.id,
      { contactId },
    );
  });
}

function buildHumansByEmailIndex(
  store: ParticipantEnrichmentStore,
): Map<string, string> {
  const humansByEmail = new Map<string, string>();

  store.forEachRow("humans", (humanId, _forEachCell) => {
    const human = store.getRow("humans", humanId);
    const email = normalizeEmail(human?.email);
    if (email) {
      humansByEmail.set(email, humanId);
    }
  });

  return humansByEmail;
}

function findOrCreateHuman(
  store: ParticipantEnrichmentStore,
  humansByEmail: Map<string, string>,
  info: DigitalBrainParticipantInfo,
  userId: string,
) {
  const existingHumanId = info.emails
    .map((email) => humansByEmail.get(email))
    .find((humanId): humanId is string => !!humanId);

  if (existingHumanId) {
    const human = store.getRow("humans", existingHumanId);
    const nextName = info.name || info.aliases[0];
    if (
      nextName &&
      (!human.name || info.emails.includes(normalizeEmail(human.name)))
    ) {
      store.setPartialRow("humans", existingHumanId, { name: nextName });
    }
    for (const email of info.emails) {
      humansByEmail.set(email, existingHumanId);
    }
    return existingHumanId;
  }

  const humanId = id();
  const primaryEmail = info.emails[0];
  store.setRow("humans", humanId, {
    user_id: userId,
    name: info.name || info.aliases[0] || primaryEmail,
    email: primaryEmail,
    org_id: "",
    job_title: "",
    linkedin_username: "",
    memo: "",
    pinned: false,
  } satisfies HumanStorage);

  for (const email of info.emails) {
    humansByEmail.set(email, humanId);
  }

  return humanId;
}

function upsertCurrentUserHuman(
  store: ParticipantEnrichmentStore,
  userId: string,
  info: DigitalBrainParticipantInfo,
  currentUserEmail?: string | null,
) {
  const primaryEmail = normalizeEmail(currentUserEmail) || info.emails[0] || "";
  const existing = store.getRow("humans", userId);
  const nextName =
    info.name || info.aliases[0] || existing.name || primaryEmail;

  store.setPartialRow("humans", userId, {
    user_id: userId,
    name: nextName,
    email: existing.email || primaryEmail,
    org_id: existing.org_id || "",
    job_title: existing.job_title || "",
    linkedin_username: existing.linkedin_username || "",
    memo: existing.memo || "",
    pinned: typeof existing.pinned === "boolean" ? existing.pinned : false,
  });
}

function getSessionMappings(
  store: ParticipantEnrichmentStore,
  sessionId: string,
) {
  const mappings: Array<{
    id: string;
    humanId: string;
    email: string;
    source?: string;
  }> = [];

  store.forEachRow("mapping_session_participant", (mappingId, _forEachCell) => {
    const mapping = store.getRow("mapping_session_participant", mappingId);
    if (mapping?.session_id !== sessionId || !mapping.human_id) {
      return;
    }

    const human = store.getRow("humans", mapping.human_id);
    const email = normalizeEmail(human?.email);
    mappings.push({
      id: mappingId,
      humanId: mapping.human_id,
      email,
      source: typeof mapping.source === "string" ? mapping.source : undefined,
    });
  });

  return mappings;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.map(readString).filter((v): v is string => !!v))];
}

function uniqueNormalized(values: unknown[]) {
  return [
    ...new Set(values.map((value) => normalizeEmail(value)).filter((v) => !!v)),
  ];
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function truncateLog(value: string, max = 500) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
