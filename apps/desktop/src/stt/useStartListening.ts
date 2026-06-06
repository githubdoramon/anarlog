import { useCallback, useRef } from "react";

import { commands as analyticsCommands } from "@hypr/plugin-analytics";
import { commands as fsSyncCommands } from "@hypr/plugin-fs-sync";
import type { TranscriptStorage } from "@hypr/store";

import { useListener } from "./contexts";
import { useKeywords } from "./useKeywords";
import {
  canRunBatchTranscription,
  createAppendBatchPersist,
  isStoppedTranscriptionError,
  useRunBatch,
} from "./useRunBatch";
import { useSTTConnection } from "./useSTTConnection";

import { useAuth } from "~/auth";
import { enrichSessionParticipantsFromDigitalBrain } from "~/services/digital-brain/participants";
import { getEnhancerService } from "~/services/enhancer";
import { getMeetingTranscriptUploadService } from "~/services/meeting-transcript-upload";
import { getSpeakerIdentificationService } from "~/services/speaker-identification";
import { getSessionEventById } from "~/session/utils";
import { useConfigValue } from "~/shared/config";
import { id } from "~/shared/utils";
import * as main from "~/store/tinybase/store/main";
import type {
  LiveTranscriptPersistCallback,
  OnStoppedCallback,
} from "~/store/zustand/listener/transcript";
import {
  getLiveTranscriptionConfig,
  getTranscriptionLanguages,
} from "~/stt/capabilities";
import {
  collectSessionParticipantHumanIds,
  getBatchSpeakerBounds,
  getExpectedRemoteSpeakerCount,
} from "~/stt/diarization";
import { applyLiveTranscriptDelta } from "~/stt/utils";

const AUDIO_PATH_RETRY_COUNT = 10;
const AUDIO_PATH_RETRY_DELAY_MS = 200;

async function resolveStoppedAudioPath(
  sessionId: string,
  eventAudioPath: string | null,
) {
  if (eventAudioPath) {
    return eventAudioPath;
  }

  for (let attempt = 0; attempt < AUDIO_PATH_RETRY_COUNT; attempt++) {
    const result = await fsSyncCommands.audioPath(sessionId);
    if (result.status === "ok" && result.data) {
      console.info("[listener] resolved stopped audio path", {
        sessionId,
        audioPath: result.data,
        attempt,
      });
      return result.data;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, AUDIO_PATH_RETRY_DELAY_MS),
    );
  }

  console.warn("[listener] stopped audio path missing after retries", {
    sessionId,
    retryCount: AUDIO_PATH_RETRY_COUNT,
    retryDelayMs: AUDIO_PATH_RETRY_DELAY_MS,
  });
  return null;
}

async function resolveExistingAudioDurationMs(sessionId: string) {
  const pathResult = await fsSyncCommands.audioPath(sessionId);
  if (pathResult.status === "error" || !pathResult.data) {
    return 0;
  }

  const metadataResult = await fsSyncCommands.audioSourceMetadata(
    pathResult.data,
  );
  if (metadataResult.status === "error") {
    return 0;
  }

  const durationMs = metadataResult.data.durationMs;
  return typeof durationMs === "number" && durationMs > 0 ? durationMs : 0;
}

function getSessionTranscriptIds(
  indexes: ReturnType<typeof main.UI.useIndexes>,
  sessionId: string,
): string[] {
  return (
    indexes?.getSliceRowIds(main.INDEXES.transcriptBySession, sessionId) ?? []
  );
}

function getAppendStartedAt(
  store: NonNullable<ReturnType<typeof main.UI.useStore>>,
  transcriptIds: string[],
  offsetMs: number,
  fallbackStartedAt: number,
) {
  if (transcriptIds.length === 0 || offsetMs <= 0) {
    return fallbackStartedAt;
  }

  const startedAts = transcriptIds
    .map((transcriptId) =>
      store.getCell("transcripts", transcriptId, "started_at"),
    )
    .filter(
      (startedAt): startedAt is number =>
        typeof startedAt === "number" && Number.isFinite(startedAt),
    );
  const earliestStartedAt = Math.min(...startedAts);

  return Number.isFinite(earliestStartedAt)
    ? earliestStartedAt + offsetMs
    : fallbackStartedAt;
}

export function getPostCaptureAction(
  details: {
    audioPath: string | null;
    liveTranscriptionActive: boolean;
  },
  canRunBatch: boolean,
) {
  if (details.liveTranscriptionActive) {
    return "enhance_only" as const;
  }

  if (!!details.audioPath && canRunBatch) {
    return "batch_then_enhance" as const;
  }

  return "none" as const;
}

export function useStartListening(sessionId: string) {
  const auth = useAuth();
  const { user_id } = main.UI.useValues(main.STORE_ID);
  const store = main.UI.useStore(main.STORE_ID);
  const indexes = main.UI.useIndexes(main.STORE_ID);

  const aiLanguage = useConfigValue("ai_language");
  const spokenLanguages = useConfigValue("spoken_languages");

  const start = useListener((state) => state.start);
  const { conn } = useSTTConnection();
  const runBatch = useRunBatch(sessionId);

  const keywords = useKeywords(sessionId);
  const runBatchRef = useRef(runBatch);
  runBatchRef.current = runBatch;

  const startListening = useCallback(async () => {
    if (!store) {
      return;
    }

    let transcriptId: string | null = null;
    const startedAt = Date.now();
    const memoMd = store.getCell("sessions", sessionId, "raw_md");
    const createdAt = new Date().toISOString();
    const existingTranscriptIds = getSessionTranscriptIds(indexes, sessionId);
    const hasExistingTranscripts = existingTranscriptIds.length > 0;
    const resumeOffsetMs = hasExistingTranscripts
      ? await resolveExistingAudioDurationMs(sessionId)
      : 0;
    const transcriptStartedAt = getAppendStartedAt(
      store,
      existingTranscriptIds,
      resumeOffsetMs,
      startedAt,
    );
    const captureConn = conn;
    const canRunBatchAfterStop = canRunBatchTranscription(captureConn);
    const expectedRemoteSpeakerCount = getExpectedRemoteSpeakerCount(
      store,
      sessionId,
    );
    const batchSpeakerBounds = getBatchSpeakerBounds(
      expectedRemoteSpeakerCount,
    );

    const onStopped: OnStoppedCallback = async (_sessionId, details) => {
      const audioPath = await resolveStoppedAudioPath(
        _sessionId,
        details.audioPath,
      );
      const postCaptureAction = getPostCaptureAction(
        { ...details, audioPath },
        canRunBatchAfterStop,
      );
      console.info("[listener] post-capture action", {
        sessionId: _sessionId,
        eventAudioPath: details.audioPath,
        resolvedAudioPath: audioPath,
        canRunBatch: canRunBatchAfterStop,
        action: postCaptureAction,
      });

      if (postCaptureAction === "batch_then_enhance") {
        try {
          const handlePersist =
            hasExistingTranscripts && resumeOffsetMs > 0
              ? createAppendBatchPersist({
                  store,
                  sessionId,
                  userId: user_id ?? "",
                  createdAt,
                  startedAt: transcriptStartedAt,
                  memoMd: typeof memoMd === "string" ? memoMd : "",
                  providerId: captureConn?.provider ?? "",
                  cutoffMs: resumeOffsetMs,
                })
              : undefined;

          await runBatchRef.current(audioPath!, {
            handlePersist,
            provider: captureConn?.provider,
            model: captureConn?.model,
            baseUrl: captureConn?.baseUrl,
            apiKey: captureConn?.apiKey,
            numSpeakers: batchSpeakerBounds?.numSpeakers,
            maxSpeakers: batchSpeakerBounds?.maxSpeakers,
          });
        } catch (error) {
          if (isStoppedTranscriptionError(error)) {
            return;
          }
          console.error(
            "[listener] failed to run post-capture transcription",
            error,
          );
          return;
        }
      }

      if (postCaptureAction === "none") {
        return;
      }

      if (details.liveTranscriptionActive) {
        void getMeetingTranscriptUploadService()?.enqueueSession(sessionId);
      }
      await getSpeakerIdentificationService()?.matchAndApplyBeforeEnhance(
        sessionId,
        audioPath,
      );
      getEnhancerService()?.queueAutoEnhanceIfSummaryEmpty(sessionId);
    };

    const handlePersist: LiveTranscriptPersistCallback = (delta) => {
      if (delta.new_words.length === 0 && delta.replaced_ids.length === 0) {
        return;
      }

      if (!transcriptId) {
        transcriptId = id();
        const transcriptRow = {
          session_id: sessionId,
          user_id: user_id ?? "",
          created_at: createdAt,
          started_at: transcriptStartedAt,
          words: "[]",
          speaker_hints: "[]",
          memo_md: typeof memoMd === "string" ? memoMd : "",
        } satisfies TranscriptStorage;

        store.setRow("transcripts", transcriptId, transcriptRow);
      }

      store.transaction(() => {
        applyLiveTranscriptDelta(store, transcriptId!, delta);
      });
    };

    await enrichSessionParticipantsFromDigitalBrain({
      store,
      sessionId,
      authHeaders: auth.getHeaders(),
      currentUserEmail: auth.session?.user.email,
    });

    const participantHumanIds = collectSessionParticipantHumanIds(
      store,
      sessionId,
    );

    const languages = getTranscriptionLanguages(aiLanguage, spokenLanguages);
    const liveTranscriptionConfig = await getLiveTranscriptionConfig({
      provider: conn?.provider,
      model: conn?.model,
      languages,
    });

    const started = await start(
      {
        session_id: sessionId,
        languages: liveTranscriptionConfig.languages,
        onboarding: false,
        model: conn?.model ?? "",
        base_url: conn?.baseUrl ?? "",
        api_key: conn?.apiKey ?? "",
        keywords,
        transcription_mode: liveTranscriptionConfig.transcriptionMode,
        participant_human_ids: participantHumanIds,
        self_human_id: typeof user_id === "string" ? user_id : null,
        expected_remote_speaker_count: expectedRemoteSpeakerCount ?? null,
      },
      {
        handlePersist,
        onStopped,
      },
    );

    if (!started) {
      if (transcriptId) {
        store.delRow("transcripts", transcriptId);
      }
      return;
    }

    void analyticsCommands.event({
      event: "session_started",
      has_calendar_event: !!getSessionEventById(store, sessionId),
      ...(conn
        ? {
            stt_provider: conn.provider,
            stt_model: conn.model,
          }
        : {}),
    });
  }, [
    aiLanguage,
    conn,
    indexes,
    store,
    sessionId,
    start,
    keywords,
    user_id,
    spokenLanguages,
    auth,
  ]);

  return startListening;
}
