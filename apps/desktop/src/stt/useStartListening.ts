import { useCallback, useRef } from "react";

import { commands as analyticsCommands } from "@hypr/plugin-analytics";
import { commands as fsSyncCommands } from "@hypr/plugin-fs-sync";
import type { TranscriptStorage } from "@hypr/store";

import { useListener } from "./contexts";
import { useKeywords } from "./useKeywords";
import {
  canRunBatchTranscription,
  isStoppedTranscriptionError,
  useRunBatch,
} from "./useRunBatch";
import { useSTTConnection } from "./useSTTConnection";

import { getEnhancerService } from "~/services/enhancer";
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
  const { user_id } = main.UI.useValues(main.STORE_ID);
  const store = main.UI.useStore(main.STORE_ID);

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
          await runBatchRef.current(audioPath!, {
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
          started_at: startedAt,
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
    store,
    sessionId,
    start,
    keywords,
    user_id,
    spokenLanguages,
  ]);

  return startListening;
}
