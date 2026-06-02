import { useMutation } from "@tanstack/react-query";
import { CheckIcon, MinusIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { commands as fsSyncCommands } from "@hypr/plugin-fs-sync";
import { cn } from "@hypr/utils";

import * as main from "~/store/tinybase/store/main";
import {
  applyProviderSpeakerCount,
  collectSessionParticipantHumanIds,
  getExpectedRemoteSpeakerCount,
  getProviderSpeakerStats,
} from "~/stt/diarization";
import { useRunBatch } from "~/stt/useRunBatch";
import { upsertSpeakerAssignment } from "~/stt/utils";

const REMOTE_CHANNEL = 1;

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

    return collectSessionParticipantHumanIds(store, sessionId)
      .filter((humanId) => humanId !== selfHumanId)
      .map((humanId) => {
        const human = store.getRow("humans", humanId);
        return {
          id: humanId,
          name:
            typeof human.name === "string" && human.name
              ? human.name
              : "Unnamed",
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
    (speakerIndex: number, anchorWordId: string, humanId: string) => {
      if (!store || !humanId) {
        return;
      }

      upsertSpeakerAssignment(
        store,
        transcriptId,
        {
          channel: "RemoteParty",
          speaker_index: speakerIndex,
          speaker_human_id: null,
        },
        humanId,
        anchorWordId,
      );
    },
    [store, transcriptId],
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

      {speakerStats.length > 0 && (
        <div className="grid gap-1.5">
          {speakerStats.map((speaker) => (
            <div
              key={speaker.speakerIndex}
              className="grid grid-cols-[minmax(0,1fr)_minmax(120px,180px)] items-center gap-2"
            >
              <div className="truncate text-neutral-700">
                Speaker {speaker.speakerIndex + 1}
                <span className="ml-2 text-neutral-400">
                  {formatDuration(speaker.durationMs)}
                </span>
              </div>
              <select
                className={cn([
                  "h-7 rounded-md border border-neutral-200 bg-white px-2",
                  "text-xs text-neutral-700 outline-hidden",
                  "focus:border-neutral-400",
                ])}
                value={speaker.assignedHumanId ?? ""}
                onChange={(event) =>
                  handleAssign(
                    speaker.speakerIndex,
                    speaker.anchorWordId,
                    event.target.value,
                  )
                }
              >
                <option value="">Unassigned</option>
                {participants.map((participant) => (
                  <option key={participant.id} value={participant.id}>
                    {participant.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
