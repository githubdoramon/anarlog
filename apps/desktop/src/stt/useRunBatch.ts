import { useCallback } from "react";

import type { TranscriptionParams } from "@hypr/plugin-transcription";
import type { TranscriptStorage } from "@hypr/store";

import { useListener } from "./contexts";
import { useKeywords } from "./useKeywords";
import { useSTTConnection } from "./useSTTConnection";

import { getMeetingTranscriptUploadService } from "~/services/meeting-transcript-upload";
import { useConfigValue } from "~/shared/config";
import { id } from "~/shared/utils";
import * as main from "~/store/tinybase/store/main";
import type { BatchPersistCallback } from "~/store/zustand/listener/transcript";
import { getTranscriptionLanguages } from "~/stt/capabilities";
import {
  getBatchSpeakerBounds,
  getExpectedRemoteSpeakerCount,
} from "~/stt/diarization";
import type { SpeakerHintWithId, WordWithId } from "~/stt/types";
import {
  parseTranscriptHints,
  parseTranscriptWords,
  updateTranscriptHints,
  updateTranscriptWords,
} from "~/stt/utils";

type RunOptions = {
  handlePersist?: BatchPersistCallback;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  keywords?: string[];
  languages?: string[];
  numSpeakers?: number;
  minSpeakers?: number;
  maxSpeakers?: number;
};

const DIRECT_BATCH_PROVIDERS: Set<TranscriptionParams["provider"]> = new Set([
  "deepgram",
  "soniox",
  "assemblyai",
  "openai",
  "gladia",
  "elevenlabs",
  "mistral",
  "fireworks",
  "pyannote",
  "aquavoice",
]);

export const STOPPED_TRANSCRIPTION_ERROR_MESSAGE = "Transcription stopped.";

type BatchAppendPersistOptions = {
  store: NonNullable<ReturnType<typeof main.UI.useStore>>;
  sessionId: string;
  userId: string;
  createdAt: string;
  startedAt: number;
  memoMd: string;
  providerId: string;
  cutoffMs: number;
};

export function getBatchProvider(
  provider: string,
  model: string,
): TranscriptionParams["provider"] | null {
  if (provider === "hyprnote") {
    if (model.startsWith("soniqo-")) return "soniqo";
    if (model.startsWith("am-")) return "am";
    if (model.startsWith("cactus-")) return "cactus";
    return "hyprnote";
  }
  if (DIRECT_BATCH_PROVIDERS.has(provider as TranscriptionParams["provider"])) {
    return provider as TranscriptionParams["provider"];
  }
  return null;
}

export function canRunBatchTranscription(
  conn: { provider: string; model: string } | null,
  modelOverride?: string,
) {
  if (!conn) {
    return false;
  }

  return getBatchProvider(conn.provider, modelOverride ?? conn.model) != null;
}

export function isStoppedTranscriptionError(error: unknown) {
  return (
    (error instanceof Error ? error.message : String(error)) ===
    STOPPED_TRANSCRIPTION_ERROR_MESSAGE
  );
}

export const useRunBatch = (sessionId: string) => {
  const store = main.UI.useStore(main.STORE_ID);
  const indexes = main.UI.useIndexes(main.STORE_ID);
  const { user_id } = main.UI.useValues(main.STORE_ID);

  const startTranscription = useListener((state) => state.startTranscription);
  const { conn } = useSTTConnection();
  const keywords = useKeywords(sessionId);
  const aiLanguage = useConfigValue("ai_language");
  const spokenLanguages = useConfigValue("spoken_languages");

  return useCallback(
    async (filePath: string, options?: RunOptions) => {
      const providerId = options?.provider ?? conn?.provider;
      const modelId = options?.model ?? conn?.model;
      const baseUrl = options?.baseUrl ?? conn?.baseUrl;
      const apiKey = options?.apiKey ?? conn?.apiKey;

      if (!store || !providerId || !modelId || !startTranscription) {
        throw new Error(
          "STT connection is not available. Please configure your speech-to-text provider.",
        );
      }

      const provider = getBatchProvider(providerId, modelId);

      if (!provider) {
        throw new Error(
          `Batch transcription is not supported for provider: ${providerId}`,
        );
      }

      const createdAt = new Date().toISOString();
      const memoMd = store.getCell("sessions", sessionId, "raw_md");
      let transcriptId: string | null = null;
      const defaultSpeakerBounds = getBatchSpeakerBounds(
        getExpectedRemoteSpeakerCount(store, sessionId),
      );
      const numSpeakers =
        options?.numSpeakers ?? defaultSpeakerBounds?.numSpeakers;
      const maxSpeakers =
        options?.maxSpeakers ??
        (typeof numSpeakers === "number"
          ? undefined
          : defaultSpeakerBounds?.maxSpeakers);

      const handlePersist: BatchPersistCallback | undefined =
        options?.handlePersist;

      const persist =
        handlePersist ??
        ((words, hints) => {
          if (words.length === 0) {
            return;
          }

          if (!transcriptId) {
            transcriptId = id();
            const currentTranscriptId = transcriptId;

            const transcriptRow = {
              session_id: sessionId,
              user_id: user_id ?? "",
              created_at: createdAt,
              started_at: Date.now(),
              words: "[]",
              speaker_hints: "[]",
              memo_md: typeof memoMd === "string" ? memoMd : "",
            } satisfies TranscriptStorage;

            store.transaction(() => {
              const transcriptIds =
                indexes?.getSliceRowIds(
                  main.INDEXES.transcriptBySession,
                  sessionId,
                ) ?? [];

              for (const existingTranscriptId of transcriptIds) {
                store.delRow("transcripts", existingTranscriptId);
              }

              store.setRow("transcripts", currentTranscriptId, transcriptRow);
            });
          }

          const currentTranscriptId = transcriptId;
          if (!currentTranscriptId) {
            return;
          }

          const existingWords = parseTranscriptWords(
            store,
            currentTranscriptId,
          );
          const existingHints = parseTranscriptHints(
            store,
            currentTranscriptId,
          );

          const newWords: WordWithId[] = [];
          const newWordIds: string[] = [];

          words.forEach((word) => {
            const wordId = id();

            newWords.push({
              id: wordId,
              text: word.text,
              start_ms: word.start_ms,
              end_ms: word.end_ms,
              channel: word.channel,
            });

            newWordIds.push(wordId);
          });

          const newHints: SpeakerHintWithId[] = [];

          hints.forEach((hint) => {
            if (hint.data.type !== "provider_speaker_index") {
              return;
            }

            const wordId = newWordIds[hint.wordIndex];
            const word = words[hint.wordIndex];

            if (!wordId || !word) {
              return;
            }

            newHints.push({
              id: id(),
              word_id: wordId,
              type: "provider_speaker_index",
              value: JSON.stringify({
                provider: hint.data.provider ?? providerId,
                channel: hint.data.channel ?? word.channel,
                speaker_index: hint.data.speaker_index,
              }),
            });
          });

          updateTranscriptWords(store, currentTranscriptId, [
            ...existingWords,
            ...newWords,
          ]);
          updateTranscriptHints(store, currentTranscriptId, [
            ...existingHints,
            ...newHints,
          ]);
        });

      const params: TranscriptionParams = {
        session_id: sessionId,
        provider,
        file_path: filePath,
        model: modelId,
        base_url: baseUrl ?? "",
        api_key: apiKey ?? "",
        keywords: options?.keywords ?? keywords ?? [],
        languages:
          options?.languages ??
          getTranscriptionLanguages(aiLanguage, spokenLanguages),
        num_speakers: numSpeakers,
        min_speakers: options?.minSpeakers,
        max_speakers: maxSpeakers,
      };

      await startTranscription(params, { handlePersist: persist });
      void getMeetingTranscriptUploadService()?.enqueueSession(sessionId);
    },
    [
      conn,
      aiLanguage,
      indexes,
      keywords,
      spokenLanguages,
      startTranscription,
      sessionId,
      store,
      user_id,
    ],
  );
};

export function createAppendBatchPersist({
  store,
  sessionId,
  userId,
  createdAt,
  startedAt,
  memoMd,
  providerId,
  cutoffMs,
}: BatchAppendPersistOptions): BatchPersistCallback {
  let transcriptId: string | null = null;

  return (words, hints) => {
    const keptEntries = words
      .map((word, originalIndex) => ({ word, originalIndex }))
      .filter(({ word }) => word.end_ms > cutoffMs);

    if (keptEntries.length === 0) {
      return;
    }

    if (!transcriptId) {
      transcriptId = id();
      const transcriptRow = {
        session_id: sessionId,
        user_id: userId,
        created_at: createdAt,
        started_at: startedAt,
        words: "[]",
        speaker_hints: "[]",
        memo_md: memoMd,
      } satisfies TranscriptStorage;

      store.setRow("transcripts", transcriptId, transcriptRow);
    }

    const currentTranscriptId = transcriptId;
    const existingWords = parseTranscriptWords(store, currentTranscriptId);
    const existingHints = parseTranscriptHints(store, currentTranscriptId);
    const nextWordIndexByOriginalIndex = new Map<number, number>();
    const newWords: WordWithId[] = [];
    const newWordIds: string[] = [];

    keptEntries.forEach(({ word, originalIndex }) => {
      const wordId = id();
      nextWordIndexByOriginalIndex.set(originalIndex, newWords.length);
      newWordIds.push(wordId);
      newWords.push({
        id: wordId,
        text: word.text,
        start_ms: Math.max(0, word.start_ms - cutoffMs),
        end_ms: Math.max(0, word.end_ms - cutoffMs),
        channel: word.channel,
      });
    });

    const newHints: SpeakerHintWithId[] = [];

    hints.forEach((hint) => {
      if (hint.data.type !== "provider_speaker_index") {
        return;
      }

      const nextWordIndex = nextWordIndexByOriginalIndex.get(hint.wordIndex);
      if (nextWordIndex === undefined) {
        return;
      }

      const wordId = newWordIds[nextWordIndex];
      const word = keptEntries[nextWordIndex]?.word;

      if (!wordId || !word) {
        return;
      }

      newHints.push({
        id: id(),
        word_id: wordId,
        type: "provider_speaker_index",
        value: JSON.stringify({
          provider: hint.data.provider ?? providerId,
          channel: hint.data.channel ?? word.channel,
          speaker_index: hint.data.speaker_index,
        }),
      });
    });

    updateTranscriptWords(store, currentTranscriptId, [
      ...existingWords,
      ...newWords,
    ]);
    updateTranscriptHints(store, currentTranscriptId, [
      ...existingHints,
      ...newHints,
    ]);
  };
}
