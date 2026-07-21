import { describe, expect, it } from "vitest";

import {
  applyProviderSpeakerCount,
  getBatchSpeakerBounds,
  getExpectedRemoteSpeakerCount,
  getProviderSpeakerStats,
} from "./diarization";

type TranscriptRow = {
  words?: string;
  speaker_hints?: string;
};

function createStore(row: TranscriptRow) {
  const transcript = {
    words: row.words ?? JSON.stringify([]),
    speaker_hints: row.speaker_hints ?? JSON.stringify([]),
  };

  return {
    getCell: (
      tableId: "transcripts",
      rowId: string,
      cellId: "words" | "speaker_hints",
    ) => {
      if (tableId !== "transcripts" || rowId !== "transcript-1") {
        return undefined;
      }

      return transcript[cellId];
    },
    setCell: (
      tableId: "transcripts",
      rowId: string,
      cellId: "words" | "speaker_hints",
      value: string,
    ) => {
      if (tableId !== "transcripts" || rowId !== "transcript-1") {
        return;
      }

      transcript[cellId] = value;
    },
  };
}

function createParticipantStore(
  rows: Array<{ humanId: string; source?: string }>,
  selfHumanId = "self",
) {
  return {
    forEachRow: (
      tableId: "mapping_session_participant",
      callback: (rowId: string, forEachCell: unknown) => void,
    ) => {
      if (tableId !== "mapping_session_participant") {
        return;
      }

      rows.forEach((_, index) => callback(`mapping-${index}`, undefined));
    },
    getCell: (
      tableId: "mapping_session_participant",
      rowId: string,
      cellId: "session_id" | "human_id" | "source",
    ) => {
      if (tableId !== "mapping_session_participant") {
        return undefined;
      }

      const index = Number(rowId.replace("mapping-", ""));
      const row = rows[index];
      if (!row) {
        return undefined;
      }

      if (cellId === "session_id") {
        return "session-1";
      }
      if (cellId === "human_id") {
        return row.humanId;
      }
      return row.source;
    },
    getValue: (valueId: "user_id") =>
      valueId === "user_id" ? selfHumanId : undefined,
  };
}

describe("getBatchSpeakerBounds", () => {
  it("forces one speaker and caps multi-speaker calls", () => {
    expect(getBatchSpeakerBounds(undefined)).toEqual(undefined);
    expect(getBatchSpeakerBounds(1)).toEqual({ numSpeakers: 1 });
    expect(getBatchSpeakerBounds(3)).toEqual({ maxSpeakers: 3 });
  });
});

describe("getExpectedRemoteSpeakerCount", () => {
  it("subtracts the local user from calendar rosters", () => {
    const store = createParticipantStore([
      { humanId: "calendar-self", source: "auto" },
      { humanId: "remote", source: "auto" },
    ]);

    expect(getExpectedRemoteSpeakerCount(store, "session-1")).toBe(1);
  });

  it("treats manual participants as remote people", () => {
    const store = createParticipantStore([
      { humanId: "remote-1", source: "manual" },
      { humanId: "remote-2", source: "manual" },
    ]);

    expect(getExpectedRemoteSpeakerCount(store, "session-1")).toBe(2);
  });
});

describe("applyProviderSpeakerCount", () => {
  it("merges extra remote speakers into the requested count", () => {
    const store = createStore({
      words: JSON.stringify([
        {
          id: "a",
          text: " one",
          start_ms: 0,
          end_ms: 1000,
          channel: 1,
        },
        {
          id: "b",
          text: " two",
          start_ms: 1000,
          end_ms: 2000,
          channel: 1,
        },
        {
          id: "c",
          text: " three",
          start_ms: 2000,
          end_ms: 2100,
          channel: 1,
        },
      ]),
      speaker_hints: JSON.stringify([
        {
          id: "a:provider_speaker_index",
          word_id: "a",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 0 }),
        },
        {
          id: "b:provider_speaker_index",
          word_id: "b",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 1 }),
        },
        {
          id: "c:provider_speaker_index",
          word_id: "c",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 2 }),
        },
      ]),
    });

    applyProviderSpeakerCount(store, "transcript-1", 1, 1);

    const hints = JSON.parse(
      store.getCell("transcripts", "transcript-1", "speaker_hints") as string,
    );
    expect(
      hints.map((hint: { value: string }) => JSON.parse(hint.value)),
    ).toEqual([
      { channel: 1, speaker_index: 0 },
      { channel: 1, speaker_index: 0 },
      { channel: 1, speaker_index: 0 },
    ]);
  });

  it("keeps speaker assignments attached to their remapped anchor word", () => {
    const store = createStore({
      words: JSON.stringify([
        {
          id: "dominant",
          text: " dominant",
          start_ms: 0,
          end_ms: 2000,
          channel: 1,
        },
        {
          id: "assigned",
          text: " assigned",
          start_ms: 2000,
          end_ms: 2100,
          channel: 1,
        },
      ]),
      speaker_hints: JSON.stringify([
        {
          id: "dominant:provider_speaker_index",
          word_id: "dominant",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 0 }),
        },
        {
          id: "assigned:provider_speaker_index",
          word_id: "assigned",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 2 }),
        },
        {
          id: "assigned:user_speaker_assignment",
          word_id: "assigned",
          type: "user_speaker_assignment",
          value: JSON.stringify({ human_id: "alice" }),
        },
      ]),
    });

    applyProviderSpeakerCount(store, "transcript-1", 1, 1);

    expect(getProviderSpeakerStats(store, "transcript-1", 1)).toEqual([
      {
        speakerIndex: 0,
        wordCount: 2,
        durationMs: 2100,
        anchorWordId: "dominant",
        assignedHumanId: "alice",
      },
    ]);
  });

  it("shows voice auto assignments in provider speaker stats", () => {
    const store = createStore({
      words: JSON.stringify([
        {
          id: "remote-word",
          text: " bom dia",
          start_ms: 0,
          end_ms: 1000,
          channel: 1,
        },
      ]),
      speaker_hints: JSON.stringify([
        {
          id: "remote-word:provider_speaker_index",
          word_id: "remote-word",
          type: "provider_speaker_index",
          value: JSON.stringify({ channel: 1, speaker_index: 0 }),
        },
        {
          id: "remote-word:voice_auto_assignment",
          word_id: "remote-word",
          type: "voice_auto_assignment",
          value: JSON.stringify({
            human_id: "hugo",
            contact_id: "contact-hugo",
            channel: 1,
            speaker_index: 0,
          }),
        },
      ]),
    });

    expect(getProviderSpeakerStats(store, "transcript-1", 1)).toEqual([
      {
        speakerIndex: 0,
        wordCount: 1,
        durationMs: 1000,
        anchorWordId: "remote-word",
        assignedHumanId: "hugo",
      },
    ]);
  });

  it("uses word speaker indexes when provider speaker hints are missing", () => {
    const store = createStore({
      words: JSON.stringify([
        {
          id: "remote-word",
          text: " hello",
          start_ms: 0,
          end_ms: 1000,
          channel: 1,
          speaker_index: 0,
        },
      ]),
      speaker_hints: JSON.stringify([]),
    });

    expect(getProviderSpeakerStats(store, "transcript-1", 1)).toEqual([
      {
        speakerIndex: 0,
        wordCount: 1,
        durationMs: 1000,
        anchorWordId: "remote-word",
      },
    ]);
  });

  it("exposes unindexed remote channel words as a channel speaker", () => {
    const store = createStore({
      words: JSON.stringify([
        {
          id: "remote-word",
          text: " hello",
          start_ms: 0,
          end_ms: 1000,
          channel: 1,
        },
      ]),
      speaker_hints: JSON.stringify([]),
    });

    expect(getProviderSpeakerStats(store, "transcript-1", 1)).toEqual([
      {
        speakerIndex: null,
        wordCount: 1,
        durationMs: 1000,
        anchorWordId: "remote-word",
      },
    ]);
  });
});
