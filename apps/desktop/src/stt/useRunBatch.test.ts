import { describe, expect, test } from "vitest";

import { createAppendBatchPersist, getBatchProvider } from "./useRunBatch";

describe("getBatchProvider", () => {
  test("maps pyannote to the batch transcription provider", () => {
    expect(getBatchProvider("pyannote", "parakeet-tdt-0.6b-v3")).toBe(
      "pyannote",
    );
  });

  test("keeps openai mapped to the batch transcription provider", () => {
    expect(getBatchProvider("openai", "gpt-4o-transcribe")).toBe("openai");
  });

  test("maps local soniqo models to soniqo batch provider", () => {
    expect(getBatchProvider("hyprnote", "soniqo-parakeet-batch")).toBe(
      "soniqo",
    );
  });
});

describe("createAppendBatchPersist", () => {
  test("appends only resumed batch words as a new transcript row", () => {
    const rows: Record<string, Record<string, unknown>> = {};
    const store = {
      setRow: (
        tableId: "transcripts",
        rowId: string,
        row: Record<string, unknown>,
      ) => {
        rows[`${tableId}:${rowId}`] = { ...row };
      },
      getCell: (
        tableId: "transcripts",
        rowId: string,
        cellId: "words" | "speaker_hints",
      ) => rows[`${tableId}:${rowId}`]?.[cellId],
      setCell: (
        tableId: "transcripts",
        rowId: string,
        cellId: "words" | "speaker_hints",
        value: string,
      ) => {
        rows[`${tableId}:${rowId}`]![cellId] = value;
      },
    };

    const persist = createAppendBatchPersist({
      store: store as any,
      sessionId: "session-1",
      userId: "user-1",
      createdAt: "2026-05-15T12:00:00.000Z",
      startedAt: 15_000,
      memoMd: "memo",
      providerId: "deepgram",
      cutoffMs: 10_000,
    });

    persist(
      [
        { text: "old", start_ms: 1_000, end_ms: 1_500, channel: 0 },
        { text: "new", start_ms: 10_250, end_ms: 10_500, channel: 1 },
        { text: "part", start_ms: 10_600, end_ms: 11_000, channel: 1 },
      ],
      [
        {
          wordIndex: 0,
          data: { type: "provider_speaker_index", speaker_index: 0 },
        },
        {
          wordIndex: 1,
          data: { type: "provider_speaker_index", speaker_index: 2 },
        },
      ],
    );

    const row = Object.values(rows)[0]!;
    const words = JSON.parse(row.words as string);
    const hints = JSON.parse(row.speaker_hints as string);

    expect(row).toMatchObject({
      session_id: "session-1",
      user_id: "user-1",
      created_at: "2026-05-15T12:00:00.000Z",
      started_at: 15_000,
      memo_md: "memo",
    });
    expect(words).toMatchObject([
      { text: "new", start_ms: 250, end_ms: 500, channel: 1 },
      { text: "part", start_ms: 600, end_ms: 1_000, channel: 1 },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      word_id: words[0].id,
      type: "provider_speaker_index",
    });
    expect(JSON.parse(hints[0].value)).toEqual({
      provider: "deepgram",
      channel: 1,
      speaker_index: 2,
    });
  });

  test("writes an explicit self speaker assignment for direct mic batch words", () => {
    const rows: Record<string, Record<string, unknown>> = {};
    const store = {
      setRow: (
        tableId: "transcripts",
        rowId: string,
        row: Record<string, unknown>,
      ) => {
        rows[`${tableId}:${rowId}`] = { ...row };
      },
      getCell: (
        tableId: "transcripts",
        rowId: string,
        cellId: "words" | "speaker_hints",
      ) => rows[`${tableId}:${rowId}`]?.[cellId],
      setCell: (
        tableId: "transcripts",
        rowId: string,
        cellId: "words" | "speaker_hints",
        value: string,
      ) => {
        rows[`${tableId}:${rowId}`]![cellId] = value;
      },
    };

    const persist = createAppendBatchPersist({
      store: store as any,
      sessionId: "session-1",
      userId: "self-human-id",
      createdAt: "2026-05-15T12:00:00.000Z",
      startedAt: 0,
      memoMd: "",
      providerId: "deepgram",
      cutoffMs: 0,
    });

    persist(
      [
        { text: "hello", start_ms: 1_000, end_ms: 1_500, channel: 0 },
        { text: "there", start_ms: 2_000, end_ms: 2_500, channel: 1 },
      ],
      [],
    );

    const row = Object.values(rows)[0]!;
    const words = JSON.parse(row.words as string);
    const hints = JSON.parse(row.speaker_hints as string);

    expect(hints).toContainEqual(
      expect.objectContaining({
        word_id: words[0].id,
        type: "user_speaker_assignment",
        value: JSON.stringify({
          human_id: "self-human-id",
          channel: 0,
          speaker_index: null,
        }),
      }),
    );
  });
});
