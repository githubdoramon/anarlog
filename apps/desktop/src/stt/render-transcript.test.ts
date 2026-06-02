import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderTranscriptSegmentsCommand } = vi.hoisted(() => ({
  renderTranscriptSegmentsCommand: vi.fn(),
}));

vi.mock("@hypr/plugin-transcription", () => ({
  commands: {
    renderTranscriptSegments: renderTranscriptSegmentsCommand,
  },
}));

import {
  buildRenderTranscriptRequestFromStore,
  renderTranscriptSegments,
} from "./render-transcript";

type FakeStore = {
  getCell: (tableId: string, rowId: string, cellId: string) => unknown;
  forEachRow: (
    tableId: string,
    callback: (rowId: string, forEachCell: unknown) => void,
  ) => void;
  getValue: (valueId: string) => unknown;
  getRow: (tableId: string, rowId: string) => Record<string, unknown>;
};

function createStore(participantIds = ["self", "remote"]): FakeStore {
  const transcripts = {
    late: {
      session_id: "session-1",
      started_at: 5_000,
      words: JSON.stringify([
        {
          id: "late-word",
          text: " later",
          start_ms: 100,
          end_ms: 200,
          channel: 1,
        },
      ]),
      speaker_hints: JSON.stringify([
        {
          word_id: "late-word",
          type: "user_speaker_assignment",
          value: JSON.stringify({ human_id: "remote" }),
        },
      ]),
    },
    early: {
      session_id: "session-1",
      started_at: 1_000,
      words: JSON.stringify([
        {
          id: "early-word",
          text: " hello",
          start_ms: 0,
          end_ms: 100,
          channel: 0,
        },
      ]),
      speaker_hints: JSON.stringify([]),
    },
    assignedBeforeProvider: {
      session_id: "session-1",
      started_at: 2_000,
      words: JSON.stringify([
        {
          id: "assigned-word",
          text: " assigned",
          start_ms: 0,
          end_ms: 100,
          channel: 1,
        },
      ]),
      speaker_hints: JSON.stringify([
        {
          word_id: "assigned-word",
          type: "user_speaker_assignment",
          value: JSON.stringify({ human_id: "remote" }),
        },
        {
          word_id: "assigned-word",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 2 }),
        },
      ]),
    },
    assignedExplicitScope: {
      session_id: "session-1",
      started_at: 3_000,
      words: JSON.stringify([
        {
          id: "explicit-word",
          text: " explicit",
          start_ms: 0,
          end_ms: 100,
          channel: 1,
        },
      ]),
      speaker_hints: JSON.stringify([
        {
          word_id: "explicit-word",
          type: "user_speaker_assignment",
          value: JSON.stringify({
            human_id: "remote",
            channel: 1,
            speaker_index: 0,
          }),
        },
      ]),
    },
  } as const;

  const humans = {
    self: { name: "Me" },
    remote: { name: "Remote" },
    third: { name: "Third" },
  } as const;

  const mappings = Object.fromEntries(
    participantIds.map((humanId, index) => [
      `mapping-${index}`,
      {
        session_id: "session-1",
        human_id: humanId,
      },
    ]),
  );

  return {
    getCell: (tableId, rowId, cellId) => {
      if (tableId === "transcripts") {
        return transcripts[rowId as keyof typeof transcripts]?.[
          cellId as keyof (typeof transcripts)["late"]
        ];
      }

      if (tableId === "mapping_session_participant") {
        return mappings[rowId as keyof typeof mappings]?.[
          cellId as keyof (typeof mappings)[string]
        ];
      }

      return undefined;
    },
    forEachRow: (tableId, callback) => {
      if (tableId === "humans") {
        Object.keys(humans).forEach((rowId) => callback(rowId, null));
      }
      if (tableId === "mapping_session_participant") {
        Object.keys(mappings).forEach((rowId) => callback(rowId, null));
      }
    },
    getValue: (valueId) => {
      return valueId === "user_id" ? "self" : undefined;
    },
    getRow: (tableId, rowId) => {
      if (tableId === "humans") {
        return humans[rowId as keyof typeof humans] ?? {};
      }
      return {};
    },
  };
}

describe("buildRenderTranscriptRequestFromStore", () => {
  beforeEach(() => {
    renderTranscriptSegmentsCommand.mockReset();
  });

  it("passes raw transcript rows and session participant ids to Rust", () => {
    const request = buildRenderTranscriptRequestFromStore(
      createStore() as never,
      ["late", "early"],
    );

    expect(request).not.toBeNull();
    expect(
      request?.transcripts.map((transcript) => ({
        started_at: transcript.started_at,
        word_ids: transcript.words.map((word) => word.id),
      })),
    ).toEqual([
      {
        started_at: 5_000,
        word_ids: ["late-word"],
      },
      {
        started_at: 1_000,
        word_ids: ["early-word"],
      },
    ]);
    expect(request?.participant_human_ids).toEqual(["self", "remote"]);
    expect(request?.self_human_id).toBe("self");
  });

  it("passes through all mapped participant ids for Rust-side resolution", () => {
    const request = buildRenderTranscriptRequestFromStore(
      createStore(["self", "remote", "third"]) as never,
      ["early"],
    );

    expect(request?.participant_human_ids).toEqual(["self", "remote", "third"]);
  });

  it("applies provider speaker hints before user assignments", () => {
    const request = buildRenderTranscriptRequestFromStore(
      createStore() as never,
      ["assignedBeforeProvider"],
    );

    expect(request?.transcripts[0]?.words[0]?.speaker_index).toBe(2);
    expect(request?.transcripts[0]?.assignments).toEqual([
      {
        human_id: "remote",
        scope: {
          kind: "channel_speaker",
          channel: "RemoteParty",
          speaker_index: 2,
        },
      },
    ]);
  });

  it("uses explicit user assignment scope when present", () => {
    const request = buildRenderTranscriptRequestFromStore(
      createStore() as never,
      ["assignedExplicitScope"],
    );

    expect(request?.transcripts[0]?.assignments).toEqual([
      {
        human_id: "remote",
        scope: {
          kind: "channel_speaker",
          channel: "RemoteParty",
          speaker_index: 0,
        },
      },
    ]);
  });

  it("rounds fractional millisecond timings before invoking Rust", async () => {
    renderTranscriptSegmentsCommand.mockResolvedValue({
      status: "ok",
      data: [],
    });

    await renderTranscriptSegments({
      transcripts: [
        {
          started_at: 1_000.6,
          words: [
            {
              id: "word-1",
              text: " hello",
              start_ms: 10.4,
              end_ms: 19.6,
              channel: 0,
              speaker_index: null,
            },
          ],
          assignments: [],
        },
      ],
      participant_human_ids: [],
      self_human_id: null,
      humans: [],
    });

    expect(renderTranscriptSegmentsCommand).toHaveBeenCalledWith({
      transcripts: [
        {
          started_at: 1_001,
          words: [
            {
              id: "word-1",
              text: " hello",
              start_ms: 10,
              end_ms: 20,
              channel: 0,
              speaker_index: null,
            },
          ],
          assignments: [],
        },
      ],
      participant_human_ids: [],
      self_human_id: null,
      humans: [],
    });
  });
});
