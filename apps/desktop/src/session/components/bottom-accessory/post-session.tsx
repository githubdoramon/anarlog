import {
  Loader2Icon,
  MinusIcon,
  Pencil,
  PlusIcon,
  RefreshCw,
  SquareIcon,
  TrashIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";

import { commands as fsSyncCommands } from "@hypr/plugin-fs-sync";
import { Button } from "@hypr/ui/components/ui/button";
import { Spinner } from "@hypr/ui/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@hypr/ui/components/ui/tooltip";
import { cn } from "@hypr/utils";

import * as AudioPlayer from "~/audio-player";
import { getEnhancerService } from "~/services/enhancer";
import { getSpeakerIdentificationService } from "~/services/speaker-identification";
import { Transcript } from "~/session/components/note-input/transcript";
import { useTranscriptScreen } from "~/session/components/note-input/transcript/state";
import { useListener } from "~/stt/contexts";
import { isStoppedTranscriptionError, useRunBatch } from "~/stt/useRunBatch";
import { useUploadFile } from "~/stt/useUploadFile";

export function PostSessionAccessory({
  sessionId,
  hasAudio,
  hasTranscript,
  isTranscriptExpanded,
  fillHeight = false,
}: {
  sessionId: string;
  hasAudio: boolean;
  hasTranscript: boolean;
  isTranscriptExpanded: boolean;
  fillHeight?: boolean;
}) {
  const screen = useTranscriptScreen({ sessionId });
  const isBatching = screen.kind === "running_batch";
  const timeline = isBatching ? (
    <BatchProgressTimeline sessionId={sessionId} screen={screen} />
  ) : hasAudio ? (
    <AudioPlayer.Timeline />
  ) : null;

  if (!isTranscriptExpanded && !timeline) {
    return null;
  }

  const shouldBalanceCollapsedTimeline =
    !isTranscriptExpanded && Boolean(timeline);

  return (
    <div
      className={cn([
        "flex min-h-0 flex-col",
        fillHeight && "h-full",
        isTranscriptExpanded && "gap-1",
        shouldBalanceCollapsedTimeline && "relative -mt-[6px] pb-1",
      ])}
    >
      {shouldBalanceCollapsedTimeline ? (
        <div
          aria-hidden
          className="pointer-events-none absolute top-[-4px] right-0 left-0 h-px bg-neutral-50"
        />
      ) : null}
      {isTranscriptExpanded ? (
        <TranscriptPanel
          sessionId={sessionId}
          screen={screen}
          hasAudio={hasAudio}
          hasTranscript={hasTranscript}
          isExpanded={isTranscriptExpanded}
          fillHeight={fillHeight}
        />
      ) : null}
      {timeline}
    </div>
  );
}

function TranscriptPanel({
  sessionId,
  screen,
  hasAudio,
  hasTranscript,
  isExpanded,
  fillHeight,
}: {
  sessionId: string;
  screen: ReturnType<typeof useTranscriptScreen>;
  hasAudio: boolean;
  hasTranscript: boolean;
  isExpanded: boolean;
  fillHeight: boolean;
}) {
  if (screen.kind === "running_batch") {
    return (
      <BatchingTranscriptPanel
        sessionId={sessionId}
        screen={screen}
        hasTranscript={hasTranscript}
        isExpanded={isExpanded}
        fillHeight={fillHeight}
      />
    );
  }

  if (hasTranscript) {
    return (
      <TranscriptReadyPanel
        sessionId={sessionId}
        isExpanded={isExpanded}
        fillHeight={fillHeight}
      />
    );
  }

  return (
    <TranscriptEmptyPanel
      sessionId={sessionId}
      hasAudio={hasAudio}
      isExpanded={isExpanded}
      fillHeight={fillHeight}
    />
  );
}

function useRegenerateTranscript(sessionId: string) {
  const runBatch = useRunBatch(sessionId);
  const handleBatchFailed = useListener((state) => state.handleBatchFailed);
  const getSessionMode = useListener((state) => state.getSessionMode);
  const isStartingRef = useRef(false);

  return useCallback(
    async (options?: { numSpeakers?: number }) => {
      if (
        isStartingRef.current ||
        getSessionMode(sessionId) === "running_batch"
      ) {
        console.info("[transcript-regenerate] skipped already running", {
          sessionId,
          isStarting: isStartingRef.current,
          sessionMode: getSessionMode(sessionId),
          requestedNumSpeakers: options?.numSpeakers ?? null,
        });
        return;
      }

      isStartingRef.current = true;
      console.info("[transcript-regenerate] starting", {
        sessionId,
        requestedNumSpeakers: options?.numSpeakers ?? null,
      });
      const result = await fsSyncCommands.audioPath(sessionId);
      if (result.status === "error") {
        console.info("[transcript-regenerate] audio path failed", {
          sessionId,
          error: result.error,
        });
        isStartingRef.current = false;
        return;
      }

      const audioPath = result.data;
      console.info("[transcript-regenerate] audio path resolved", {
        sessionId,
        hasAudioPath: !!audioPath,
        requestedNumSpeakers: options?.numSpeakers ?? null,
      });

      try {
        await runBatch(audioPath, {
          numSpeakers: options?.numSpeakers,
        });
        console.info("[transcript-regenerate] batch completed", {
          sessionId,
          requestedNumSpeakers: options?.numSpeakers ?? null,
        });
        await getSpeakerIdentificationService()?.matchAndApplyBeforeEnhance(
          sessionId,
          audioPath,
        );
        console.info("[transcript-regenerate] speaker match completed", {
          sessionId,
          requestedNumSpeakers: options?.numSpeakers ?? null,
        });
        getEnhancerService()?.queueAutoEnhanceIfSummaryEmpty(sessionId);
      } catch (error) {
        if (isStoppedTranscriptionError(error)) {
          console.info("[transcript-regenerate] stopped", { sessionId });
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        console.info("[transcript-regenerate] failed", {
          sessionId,
          error: msg,
        });
        handleBatchFailed(sessionId, msg);
      } finally {
        console.info("[transcript-regenerate] finished", { sessionId });
        isStartingRef.current = false;
      }
    },
    [getSessionMode, handleBatchFailed, runBatch, sessionId],
  );
}

function RegenerateSpeakerControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
      <span className="text-neutral-400">Remote speakers</span>
      <div className="flex h-6 items-center rounded-md border border-neutral-200 bg-white">
        <button
          type="button"
          aria-label="Decrease remote speakers"
          className="flex h-6 w-6 items-center justify-center text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
          onClick={() => onChange(Math.max(1, value - 1))}
        >
          <MinusIcon className="size-3" />
        </button>
        <span className="w-6 text-center font-mono text-neutral-800">
          {value}
        </span>
        <button
          type="button"
          aria-label="Increase remote speakers"
          className="flex h-6 w-6 items-center justify-center text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
          onClick={() => onChange(Math.min(12, value + 1))}
        >
          <PlusIcon className="size-3" />
        </button>
      </div>
    </div>
  );
}

function BatchingTranscriptPanel({
  sessionId,
  screen,
  hasTranscript,
  isExpanded,
  fillHeight,
}: {
  sessionId: string;
  screen: {
    kind: "running_batch";
    percentage?: number;
    phase?: "importing" | "transcribing";
  };
  hasTranscript: boolean;
  isExpanded: boolean;
  fillHeight: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stopTranscription = useListener((state) => state.stopTranscription);
  const handleStop = useCallback(() => {
    void stopTranscription(sessionId);
  }, [sessionId, stopTranscription]);
  const { percentage, phase } = screen;
  const phaseLabel = phase === "importing" ? "Importing..." : "Transcribing...";
  const canStopTranscription = phase !== "importing";

  if (!isExpanded) {
    return null;
  }

  return (
    <TranscriptCard fillHeight={fillHeight}>
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <span className="text-xs font-medium text-neutral-500">Transcript</span>
        <div className="flex items-center gap-1 px-1 py-0.5">
          <Spinner size={10} />
          <span className="text-[11px] text-neutral-500">
            {phaseLabel}
            {typeof percentage === "number" && percentage > 0 && (
              <span className="ml-1 text-neutral-400 tabular-nums">
                {Math.round(percentage * 100)}%
              </span>
            )}
          </span>
          {canStopTranscription ? (
            <StopTranscriptionButton onClick={handleStop} compact />
          ) : null}
        </div>
      </div>

      {hasTranscript ? (
        <TranscriptScrollArea fillHeight={fillHeight}>
          <Transcript sessionId={sessionId} scrollRef={scrollRef} />
        </TranscriptScrollArea>
      ) : (
        <div
          className={cn([
            "flex flex-col items-center justify-center gap-2",
            fillHeight ? "min-h-0 flex-1" : "h-[120px]",
          ])}
        >
          <Spinner size={24} />
          {typeof percentage === "number" && percentage > 0 && (
            <p className="text-xl font-medium text-neutral-500 tabular-nums">
              {Math.round(percentage * 100)}%
            </p>
          )}
          <p className="text-sm text-neutral-400">{phaseLabel}</p>
        </div>
      )}
    </TranscriptCard>
  );
}

function BatchProgressTimeline({
  sessionId,
  screen,
}: {
  sessionId: string;
  screen: Extract<
    ReturnType<typeof useTranscriptScreen>,
    { kind: "running_batch" }
  >;
}) {
  const stopTranscription = useListener((state) => state.stopTranscription);
  const handleStop = useCallback(() => {
    void stopTranscription(sessionId);
  }, [sessionId, stopTranscription]);
  const phaseLabel =
    screen.phase === "importing" ? "Importing" : "Transcribing";
  const canStopTranscription = screen.phase !== "importing";
  const progress = Math.max(0, Math.min(screen.percentage ?? 0, 1));
  const progressText =
    typeof screen.percentage === "number" && screen.percentage > 0
      ? `${Math.round(screen.percentage * 100)}%`
      : "...";

  return (
    <AudioPlayer.TimelineShell
      leading={
        <div
          className={cn([
            "flex h-8 w-8 items-center justify-center rounded-full",
            "border border-neutral-200 bg-white shadow-xs",
            "shrink-0",
          ])}
        >
          <Spinner size={14} />
        </div>
      }
      meta={
        <AudioPlayer.TimelineMeta>
          <span>{progressText}</span>
          {canStopTranscription ? (
            <StopTranscriptionButton onClick={handleStop} />
          ) : null}
        </AudioPlayer.TimelineMeta>
      }
      main={
        <div className="flex h-[30px] items-center">
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-neutral-200/80">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-neutral-400 transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(progress * 100, 8)}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="px-2 text-[10px] font-medium tracking-[0.02em] text-neutral-500">
                {phaseLabel}
              </span>
            </div>
          </div>
        </div>
      }
    />
  );
}

function StopTranscriptionButton({
  onClick,
  compact = false,
}: {
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn([
            "text-neutral-500 hover:text-neutral-700",
            compact ? "h-5 w-5" : "h-6 w-6",
          ])}
          onClick={onClick}
          aria-label="Stop transcription"
        >
          <SquareIcon size={compact ? 9 : 10} className="fill-current" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>Stop transcription</p>
      </TooltipContent>
    </Tooltip>
  );
}

function TranscriptReadyPanel({
  sessionId,
  isExpanded,
  fillHeight,
}: {
  sessionId: string;
  isExpanded: boolean;
  fillHeight: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const regenerate = useRegenerateTranscript(sessionId);
  const [remoteSpeakerCount, setRemoteSpeakerCount] = useState(2);
  const { audioExists, deleteRecording, isDeletingRecording } =
    AudioPlayer.useAudioPlayer();

  if (!isExpanded) {
    return null;
  }

  return (
    <TranscriptCard fillHeight={fillHeight}>
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled
                className={cn([
                  "flex items-center gap-1 rounded px-1.5 py-0.5",
                  "text-[11px] font-medium text-neutral-300",
                  "cursor-not-allowed",
                ])}
              >
                <Pencil size={10} />
                Edit
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Coming soon</p>
            </TooltipContent>
          </Tooltip>
          <RegenerateSpeakerControl
            value={remoteSpeakerCount}
            onChange={setRemoteSpeakerCount}
          />
          <button
            type="button"
            onClick={() => regenerate({ numSpeakers: remoteSpeakerCount })}
            className={cn([
              "flex items-center gap-1 rounded px-1.5 py-0.5",
              "text-[11px] font-medium text-neutral-500",
              "transition-colors hover:bg-neutral-200/60 hover:text-neutral-700",
            ])}
          >
            <RefreshCw size={10} />
            Regenerate
          </button>
        </div>
        {audioExists ? (
          <button
            type="button"
            onClick={() => void deleteRecording()}
            disabled={isDeletingRecording}
            className={cn([
              "flex items-center gap-1 rounded px-1.5 py-0.5",
              "text-[11px] font-medium text-red-600",
              "transition-colors hover:bg-red-50 hover:text-red-700",
              "disabled:cursor-not-allowed disabled:text-red-300",
            ])}
          >
            {isDeletingRecording ? (
              <Loader2Icon size={10} className="animate-spin" />
            ) : (
              <TrashIcon size={10} />
            )}
            {isDeletingRecording ? "Deleting..." : "Delete recording"}
          </button>
        ) : null}
      </div>

      <TranscriptScrollArea fillHeight={fillHeight}>
        <Transcript sessionId={sessionId} scrollRef={scrollRef} />
      </TranscriptScrollArea>
    </TranscriptCard>
  );
}

function TranscriptEmptyPanel({
  sessionId,
  hasAudio,
  isExpanded,
  fillHeight,
}: {
  sessionId: string;
  hasAudio: boolean;
  isExpanded: boolean;
  fillHeight: boolean;
}) {
  const screen = useTranscriptScreen({ sessionId });
  const { uploadAudio } = useUploadFile(sessionId);
  const regenerate = useRegenerateTranscript(sessionId);
  const [remoteSpeakerCount, setRemoteSpeakerCount] = useState(2);

  const error = screen.kind === "empty" ? screen.error : null;

  if (!isExpanded) {
    return null;
  }

  return (
    <TranscriptCard fillHeight={fillHeight}>
      <div className="flex min-h-0 flex-1 items-center justify-between px-4 py-3">
        {error ? (
          <span className="text-xs text-red-500">{error}</span>
        ) : (
          <span className="text-xs text-neutral-400">No transcript yet</span>
        )}

        <div className="flex items-center gap-1.5">
          {hasAudio && (
            <>
              <RegenerateSpeakerControl
                value={remoteSpeakerCount}
                onChange={setRemoteSpeakerCount}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-neutral-500"
                onClick={() => regenerate({ numSpeakers: remoteSpeakerCount })}
              >
                <RefreshCw size={12} />
                Generate
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-neutral-500"
            onClick={uploadAudio}
          >
            Upload audio
          </Button>
        </div>
      </div>
    </TranscriptCard>
  );
}

function TranscriptScrollArea({
  children,
  fillHeight,
}: {
  children: ReactNode;
  fillHeight: boolean;
}) {
  return (
    <div
      className={cn([
        "overflow-y-auto px-3",
        fillHeight ? "min-h-0 flex-1" : "h-[300px]",
      ])}
    >
      {children}
    </div>
  );
}

function TranscriptCard({
  children,
  fillHeight = false,
}: {
  children: ReactNode;
  fillHeight?: boolean;
}) {
  return (
    <div
      className={cn([
        "overflow-hidden rounded-b-xl border-x border-b border-neutral-200 bg-white",
        fillHeight && "flex min-h-0 flex-1 flex-col",
      ])}
    >
      {children}
    </div>
  );
}
