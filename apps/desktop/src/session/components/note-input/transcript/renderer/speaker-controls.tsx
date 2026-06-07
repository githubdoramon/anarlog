import { useMutation, useQuery } from "@tanstack/react-query";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { CheckIcon, MinusIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { commands as fsSyncCommands } from "@hypr/plugin-fs-sync";
import type {
  HumanStorage,
  MappingSessionParticipantStorage,
} from "@hypr/store";
import { Input } from "@hypr/ui/components/ui/input";
import {
  AppFloatingPanel,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@hypr/ui/components/ui/popover";
import { cn } from "@hypr/utils";

import { useAuth } from "~/auth";
import {
  getMeetingTranscriptUploadService,
  getServerUrl,
} from "~/services/meeting-transcript-upload";
import { getSpeakerIdentificationService } from "~/services/speaker-identification";
import { id } from "~/shared/utils";
import * as main from "~/store/tinybase/store/main";
import {
  applyProviderSpeakerCount,
  collectSessionParticipantHumanIds,
  getDirectMicSpeakerStat,
  getExpectedRemoteSpeakerCount,
  getProviderSpeakerStats,
} from "~/stt/diarization";
import { useRunBatch } from "~/stt/useRunBatch";
import { upsertSpeakerAssignment } from "~/stt/utils";

const REMOTE_CHANNEL = 1;
const CONTACT_SEARCH_DEBOUNCE_MS = 250;

type AssignmentParticipant = {
  id: string;
  name: string;
  email?: string;
};

type DigitalBrainContactSearchResult = {
  contact_id: string;
  display_name: string | null;
  aliases: string[];
  emails: string[];
};

type SpeakerAssignmentMetadata = {
  contactId?: string | null;
};

type AssignmentStore = NonNullable<ReturnType<typeof main.UI.useStore>>;

export function SpeakerControls({ transcriptId }: { transcriptId: string }) {
  const store = main.UI.useStore(main.STORE_ID);
  const transcriptsTable = main.UI.useTable("transcripts", main.STORE_ID);
  const hints = main.UI.useCell(
    "transcripts",
    transcriptId,
    "speaker_hints",
    main.STORE_ID,
  );
  const sessionId = main.UI.useCell(
    "transcripts",
    transcriptId,
    "session_id",
    main.STORE_ID,
  ) as string | undefined;
  const participantMappingsTable = main.UI.useTable(
    "mapping_session_participant",
    main.STORE_ID,
  );
  const humansTable = main.UI.useTable("humans", main.STORE_ID);
  const selfHumanId = main.UI.useValue("user_id", main.STORE_ID);

  const speakerStats = useMemo(() => {
    if (!store) {
      return [];
    }

    return getProviderSpeakerStats(store, transcriptId, REMOTE_CHANNEL);
  }, [store, transcriptId, transcriptsTable, hints]);

  const directMicSpeaker = useMemo(() => {
    if (!store) {
      return null;
    }

    return getDirectMicSpeakerStat(store, transcriptId);
  }, [store, transcriptId, transcriptsTable, hints, selfHumanId]);

  const expectedCount = useMemo(() => {
    if (!store || !sessionId) {
      return undefined;
    }

    return getExpectedRemoteSpeakerCount(store, sessionId);
  }, [store, sessionId, participantMappingsTable, selfHumanId]);

  const [speakerCount, setSpeakerCount] = useState(1);
  const [hasEditedSpeakerCount, setHasEditedSpeakerCount] = useState(false);

  const detectedSpeakerCount = Math.max(1, speakerStats.length);
  const canApplyCurrentTranscript = speakerStats.length > 0;
  const suggestedSpeakerCount = Math.max(
    1,
    expectedCount ?? detectedSpeakerCount,
  );

  useEffect(() => {
    setHasEditedSpeakerCount(false);
  }, [transcriptId]);

  useEffect(() => {
    if (!hasEditedSpeakerCount) {
      setSpeakerCount(suggestedSpeakerCount);
    }
  }, [hasEditedSpeakerCount, suggestedSpeakerCount]);

  const participants = useMemo(() => {
    if (!store || !sessionId) {
      return [];
    }

    const humanIds = new Set<string>();
    if (typeof selfHumanId === "string" && selfHumanId) {
      humanIds.add(selfHumanId);
    }
    for (const humanId of collectSessionParticipantHumanIds(store, sessionId)) {
      humanIds.add(humanId);
    }

    return [...humanIds].map((humanId) => {
      const human = store.getRow("humans", humanId);
      return {
        id: humanId,
        name:
          typeof human.name === "string" && human.name
            ? human.name
            : humanId === selfHumanId
              ? "You"
              : "Unnamed",
        email: typeof human.email === "string" ? human.email : undefined,
      };
    });
  }, [store, sessionId, participantMappingsTable, humansTable, selfHumanId]);

  const runBatch = useRunBatch(sessionId ?? "");
  const reprocess = useMutation({
    mutationFn: async () => {
      if (!sessionId) {
        throw new Error("Missing session.");
      }

      const result = await fsSyncCommands.audioPath(sessionId);
      if (result.status === "error" || !result.data) {
        throw new Error(
          result.status === "error" ? result.error : "Audio file not found.",
        );
      }

      await runBatch(result.data, {
        numSpeakers: speakerCount,
      });
    },
  });

  const applyCount = useCallback(() => {
    if (!store || !canApplyCurrentTranscript) {
      return;
    }

    applyProviderSpeakerCount(
      store,
      transcriptId,
      REMOTE_CHANNEL,
      speakerCount,
    );
  }, [store, transcriptId, speakerCount, canApplyCurrentTranscript]);

  useEffect(() => {
    if (!store || !expectedCount || speakerStats.length <= expectedCount) {
      return;
    }

    applyProviderSpeakerCount(
      store,
      transcriptId,
      REMOTE_CHANNEL,
      expectedCount,
    );
  }, [store, transcriptId, expectedCount, speakerStats.length]);

  const handleAssign = useCallback(
    (
      channel: "DirectMic" | "RemoteParty",
      speakerIndex: number | null,
      anchorWordId: string,
      humanId: string,
      metadata: SpeakerAssignmentMetadata = {},
    ) => {
      if (!store || !humanId) {
        return;
      }

      upsertSpeakerAssignment(
        store,
        transcriptId,
        {
          channel,
          speaker_index: speakerIndex,
          speaker_human_id: null,
        },
        humanId,
        anchorWordId,
        { contactId: metadata.contactId },
      );
      getMeetingTranscriptUploadService()?.scheduleSpeakerAssignmentUpload(
        sessionId,
      );
      getSpeakerIdentificationService()?.scheduleSpeakerConfirmation(sessionId);
    },
    [store, transcriptId, sessionId],
  );

  if (!store || !sessionId) {
    return null;
  }

  return (
    <div
      className={cn([
        "mx-3 mt-3 flex flex-col gap-2 border-y border-neutral-200 py-2",
        "text-xs text-neutral-600",
      ])}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-neutral-700">Remote speakers</span>
          <div className="flex h-7 items-center rounded-md border border-neutral-200 bg-white">
            <IconButton
              label="Decrease speakers"
              onClick={() => {
                setHasEditedSpeakerCount(true);
                setSpeakerCount((count) => Math.max(1, count - 1));
              }}
            >
              <MinusIcon className="size-3.5" />
            </IconButton>
            <span className="w-8 text-center font-mono text-neutral-800">
              {speakerCount}
            </span>
            <IconButton
              label="Increase speakers"
              onClick={() => {
                setHasEditedSpeakerCount(true);
                setSpeakerCount((count) => Math.min(12, count + 1));
              }}
            >
              <PlusIcon className="size-3.5" />
            </IconButton>
          </div>
          {expectedCount && (
            <span className="text-neutral-400">expected {expectedCount}</span>
          )}
          <span className="text-neutral-400">
            detected {detectedSpeakerCount}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <IconButton
            label="Apply speaker count"
            disabled={!canApplyCurrentTranscript}
            onClick={applyCount}
          >
            <CheckIcon className="size-3.5" />
          </IconButton>
          <IconButton
            label="Rerun diarization"
            disabled={reprocess.isPending}
            onClick={() => reprocess.mutate()}
          >
            <RefreshCwIcon
              className={cn([
                "size-3.5",
                reprocess.isPending && "animate-spin",
              ])}
            />
          </IconButton>
        </div>
      </div>

      {(directMicSpeaker || speakerStats.length > 0) && (
        <div className="grid gap-1.5">
          {directMicSpeaker && (
            <SpeakerAssignmentRow
              transcriptId={transcriptId}
              label="Direct mic"
              durationMs={directMicSpeaker.durationMs}
              assignedHumanId={directMicSpeaker.assignedHumanId}
              participants={participants}
              onAssign={(humanId, metadata) =>
                handleAssign(
                  "DirectMic",
                  null,
                  directMicSpeaker.anchorWordId,
                  humanId,
                  metadata,
                )
              }
            />
          )}
          {speakerStats.map((speaker) => (
            <SpeakerAssignmentRow
              transcriptId={transcriptId}
              key={speaker.speakerIndex}
              label={`Speaker ${speaker.speakerIndex + 1}`}
              durationMs={speaker.durationMs}
              assignedHumanId={speaker.assignedHumanId}
              participants={participants}
              onAssign={(humanId, metadata) =>
                handleAssign(
                  "RemoteParty",
                  speaker.speakerIndex,
                  speaker.anchorWordId,
                  humanId,
                  metadata,
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SpeakerAssignmentRow({
  transcriptId,
  label,
  durationMs,
  assignedHumanId,
  participants,
  onAssign,
}: {
  transcriptId: string;
  label: string;
  durationMs: number;
  assignedHumanId?: string;
  participants: AssignmentParticipant[];
  onAssign: (humanId: string, metadata?: SpeakerAssignmentMetadata) => void;
}) {
  const assignedParticipant = participants.find(
    (participant) => participant.id === assignedHumanId,
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,180px)] items-center gap-2">
      <div className="truncate text-neutral-700">
        {label}
        <span className="ml-2 text-neutral-400">
          {formatDuration(durationMs)}
        </span>
      </div>
      <SpeakerAssignmentPicker
        assignedLabel={assignedParticipant?.name ?? "Unassigned"}
        transcriptId={transcriptId}
        participants={participants}
        onAssign={onAssign}
      />
    </div>
  );
}

function SpeakerAssignmentPicker({
  assignedLabel,
  transcriptId,
  participants,
  onAssign,
}: {
  assignedLabel: string;
  transcriptId: string;
  participants: AssignmentParticipant[];
  onAssign: (humanId: string, metadata?: SpeakerAssignmentMetadata) => void;
}) {
  const store = main.UI.useStore(main.STORE_ID);
  const sessionId = main.UI.useCell(
    "transcripts",
    transcriptId,
    "session_id",
    main.STORE_ID,
  ) as string | undefined;
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const serverUrl = getServerUrl();
  const authHeaders = useMemo(
    () => auth.getHeaders(),
    [auth, auth.session?.access_token],
  );

  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedQuery(query.trim()),
      CONTACT_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [query]);

  const contactSearch = useQuery({
    queryKey: [
      "digital-brain-contact-search",
      serverUrl,
      auth.session?.user.email,
      debouncedQuery,
    ],
    queryFn: async () => {
      const session = await auth.refreshSession();
      return searchDigitalBrainContacts(
        debouncedQuery,
        session
          ? {
              Authorization: `Bearer ${session.access_token}`,
            }
          : null,
      );
    },
    enabled: open && debouncedQuery.length >= 2 && !!serverUrl && !!authHeaders,
  });

  useEffect(() => {
    if (!open || debouncedQuery.length < 2) {
      return;
    }

    console.info("[digital-brain] contact_search_gate", {
      has_server_url: !!serverUrl,
      server_url: serverUrl,
      has_auth_headers: !!authHeaders,
      user_email: auth.session?.user.email ?? null,
      query: debouncedQuery,
      enabled: !!serverUrl && !!authHeaders,
    });
  }, [auth.session?.user.email, authHeaders, debouncedQuery, open, serverUrl]);

  useEffect(() => {
    if (!contactSearch.error) {
      return;
    }

    console.warn(
      "[digital-brain] contact_search_error",
      serializeError(contactSearch.error),
    );
  }, [contactSearch.error]);

  const handleAssignLocal = useCallback(
    (humanId: string) => {
      onAssign(humanId);
      setOpen(false);
    },
    [onAssign],
  );

  const handleAssignContact = useCallback(
    (contact: DigitalBrainContactSearchResult) => {
      if (!store || !sessionId) {
        return;
      }
      const humanId = ensureLocalParticipantForContact(
        store,
        sessionId,
        contact,
      );
      onAssign(humanId, { contactId: contact.contact_id });
      setOpen(false);
    },
    [onAssign, sessionId, store],
  );

  const handleAssignEmail = useCallback(() => {
    if (!store || !sessionId || !isEmailLike(query)) {
      return;
    }
    const humanId = ensureLocalParticipantForEmail(store, sessionId, query);
    onAssign(humanId);
    setOpen(false);
  }, [onAssign, query, sessionId, store]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn([
            "h-7 rounded-md border border-neutral-200 bg-white px-2 text-left",
            "text-xs text-neutral-700 outline-hidden",
            "hover:border-neutral-300 focus:border-neutral-400",
          ])}
        >
          <span className="block truncate">{assignedLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        variant="app"
        align="end"
        className="w-72"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <AppFloatingPanel className="flex max-h-80 flex-col gap-2 overflow-hidden p-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search contacts or enter email"
            className="h-8 text-xs"
          />

          <div className="min-h-0 overflow-auto">
            <AssignmentSection title="Meeting participants">
              {participants.map((participant) => (
                <AssignmentOption
                  key={participant.id}
                  title={participant.name}
                  subtitle={participant.email}
                  onClick={() => handleAssignLocal(participant.id)}
                />
              ))}
            </AssignmentSection>

            {isEmailLike(query) && (
              <AssignmentSection title="Manual email">
                <AssignmentOption
                  title={query.trim().toLowerCase()}
                  subtitle="Create participant and assign"
                  onClick={handleAssignEmail}
                />
              </AssignmentSection>
            )}

            {debouncedQuery.length >= 2 && (
              <AssignmentSection title="Digital Brain contacts">
                {!serverUrl && (
                  <p className="px-2 py-1 text-xs text-neutral-400">
                    Digital Brain server URL is not configured
                  </p>
                )}
                {serverUrl && !authHeaders && (
                  <p className="px-2 py-1 text-xs text-neutral-400">
                    Sign in to search contacts
                  </p>
                )}
                {serverUrl && authHeaders && contactSearch.isFetching && (
                  <p className="px-2 py-1 text-xs text-neutral-400">
                    Searching...
                  </p>
                )}
                {serverUrl && authHeaders && contactSearch.isError && (
                  <p className="px-2 py-1 text-xs text-neutral-400">
                    Contact search failed
                  </p>
                )}
                {serverUrl &&
                  authHeaders &&
                  !contactSearch.isFetching &&
                  !contactSearch.isError &&
                  (contactSearch.data ?? []).length === 0 && (
                    <p className="px-2 py-1 text-xs text-neutral-400">
                      No contacts found
                    </p>
                  )}
                {(contactSearch.data ?? []).map((contact) => (
                  <AssignmentOption
                    key={contact.contact_id}
                    title={
                      contact.display_name ??
                      contact.emails[0] ??
                      contact.contact_id
                    }
                    subtitle={contact.emails.join(", ")}
                    onClick={() => handleAssignContact(contact)}
                  />
                ))}
              </AssignmentSection>
            )}
          </div>
        </AppFloatingPanel>
      </PopoverContent>
    </Popover>
  );
}

function AssignmentSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-neutral-100 py-1 last:border-b-0">
      <div className="px-2 py-1 text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function AssignmentOption({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn([
        "flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left",
        "hover:bg-neutral-100",
      ])}
      onClick={onClick}
    >
      <span className="truncate text-xs text-neutral-800">{title}</span>
      {subtitle && (
        <span className="truncate text-[11px] text-neutral-400">
          {subtitle}
        </span>
      )}
    </button>
  );
}

async function searchDigitalBrainContacts(
  query: string,
  authHeaders: { Authorization: string } | null,
): Promise<DigitalBrainContactSearchResult[]> {
  const serverUrl = getServerUrl();
  if (!serverUrl || !authHeaders || query.trim().length < 2) {
    return [];
  }

  const response = await tauriFetch(
    `${serverUrl}/api/orchestrator/contacts?query=${encodeURIComponent(query.trim())}`,
    {
      headers: authHeaders,
    },
  );
  console.info("[digital-brain] contact_search_response", {
    path: "/api/orchestrator/contacts",
    status: response.status,
    ok: response.ok,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.warn("[digital-brain] contact_search_http_error", {
      status: response.status,
      body: truncateLog(errorText),
    });
    throw new Error(`contact search returned ${response.status}: ${errorText}`);
  }

  const body = (await response.json().catch(() => null)) as {
    contacts?: unknown;
  } | null;
  if (!Array.isArray(body?.contacts)) {
    return [];
  }

  return body.contacts.flatMap((item): DigitalBrainContactSearchResult[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const contactId = readString(record.contact_id);
    if (!contactId) {
      return [];
    }
    return [
      {
        contact_id: contactId,
        display_name: readString(record.display_name),
        aliases: readStringArray(record.aliases),
        emails: readStringArray(record.emails).map((email) =>
          email.toLowerCase(),
        ),
      },
    ];
  });
}

function ensureLocalParticipantForContact(
  store: AssignmentStore,
  sessionId: string,
  contact: DigitalBrainContactSearchResult,
): string {
  return ensureLocalParticipant(store, sessionId, {
    name:
      contact.display_name ??
      contact.aliases[0] ??
      contact.emails[0] ??
      contact.contact_id,
    email: contact.emails[0] ?? "",
  });
}

function ensureLocalParticipantForEmail(
  store: AssignmentStore,
  sessionId: string,
  email: string,
): string {
  const normalizedEmail = email.trim().toLowerCase();
  return ensureLocalParticipant(store, sessionId, {
    name: nameFromEmail(normalizedEmail),
    email: normalizedEmail,
  });
}

function ensureLocalParticipant(
  store: AssignmentStore,
  sessionId: string,
  participant: { name: string; email: string },
): string {
  const normalizedEmail = participant.email.trim().toLowerCase();
  let humanId = findHumanByEmail(store, normalizedEmail);
  const userId = String(store.getValue("user_id") ?? "");

  if (!humanId) {
    humanId = id();
    store.setRow("humans", humanId, {
      user_id: userId,
      name: participant.name,
      email: normalizedEmail,
      org_id: "",
      job_title: "",
      linkedin_username: "",
      memo: "",
      pinned: false,
    } satisfies HumanStorage);
  }

  ensureSessionParticipantMapping(store, sessionId, humanId, userId);
  return humanId;
}

function findHumanByEmail(
  store: AssignmentStore,
  email: string,
): string | null {
  if (!email) {
    return null;
  }

  let found: string | null = null;
  store.forEachRow("humans", (humanId, _forEachCell) => {
    if (found) {
      return;
    }
    const human = store.getRow("humans", humanId);
    if (
      typeof human.email === "string" &&
      human.email.trim().toLowerCase() === email
    ) {
      found = humanId;
    }
  });
  return found;
}

function ensureSessionParticipantMapping(
  store: AssignmentStore,
  sessionId: string,
  humanId: string,
  userId: string,
) {
  let existingMappingId: string | null = null;
  store.forEachRow("mapping_session_participant", (mappingId, _forEachCell) => {
    if (existingMappingId) {
      return;
    }
    const mapping = store.getRow("mapping_session_participant", mappingId);
    if (mapping?.session_id === sessionId && mapping.human_id === humanId) {
      existingMappingId = mappingId;
    }
  });

  if (existingMappingId) {
    store.setPartialRow("mapping_session_participant", existingMappingId, {
      source: "manual",
    });
    return;
  }

  store.setRow("mapping_session_participant", id(), {
    user_id: userId,
    session_id: sessionId,
    human_id: humanId,
    source: "manual",
  } satisfies MappingSessionParticipantStorage);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(readString)
        .filter((item): item is string => typeof item === "string")
    : [];
}

function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function nameFromEmail(email: string) {
  const local = email.split("@", 1)[0] || email;
  return (
    local
      .split(/[._+-]+/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ") || email
  );
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

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn([
        "flex size-7 items-center justify-center rounded-md",
        "text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800",
        "disabled:pointer-events-none disabled:opacity-50",
      ])}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function formatDuration(durationMs: number) {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
