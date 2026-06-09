import { describe, expect, it, vi } from "vitest";

import { buildDigitalBrainTranscriptionPayload } from "./payload";

type Tables = Record<string, Record<string, Record<string, any>>>;

function createStore(tables: Tables, values: Record<string, unknown> = {}) {
  return {
    getRow: vi.fn((table: string, rowId: string) => tables[table]?.[rowId]),
    getRowIds: vi.fn((table: string) => Object.keys(tables[table] ?? {})),
    getValue: vi.fn((valueId: string) => values[valueId]),
    forEachRow: vi.fn(
      (table: string, callback: (rowId: string, cell: unknown) => void) => {
        for (const rowId of Object.keys(tables[table] ?? {})) {
          callback(rowId, undefined);
        }
      },
    ),
  } as any;
}

function word(id: string, channel: number) {
  return {
    id,
    text: "hello",
    start_ms: 0,
    end_ms: 100,
    channel,
  };
}

describe("buildDigitalBrainTranscriptionPayload", () => {
  it("uses Google tracking id as the original meeting id", () => {
    const store = createStore(
      {
        sessions: {
          "session-1": {
            title: "Fallback",
            event_json: JSON.stringify({
              tracking_id: "google-event-1",
              calendar_id: "calendar-1",
              title: "Weekly Sync",
              started_at: "2026-06-01T10:00:00Z",
              ended_at: "2026-06-01T10:30:00Z",
              description: "Discuss work",
            }),
          },
        },
        events: {
          "event-1": {
            tracking_id_event: "google-event-1",
            provider: "google",
            participants_json: JSON.stringify([
              { name: "Alice", email: "alice@example.com" },
            ]),
          },
        },
        calendars: {},
        humans: {},
        mapping_session_participant: {},
        transcripts: {
          "transcript-1": {
            session_id: "session-1",
            user_id: "user-1",
            created_at: "2026-06-01T10:00:00Z",
            started_at: 100,
            words: JSON.stringify([word("word-1", 0)]),
            speaker_hints: "[]",
            memo_md: "",
          },
        },
      },
      { user_id: "user-1" },
    );

    const payload = buildDigitalBrainTranscriptionPayload({
      store,
      sessionId: "session-1",
      currentUserEmail: "me@example.com",
    });

    expect(payload?.meeting).toMatchObject({
      original_id: "google-event-1",
      provider: "google",
      title: "Weekly Sync",
      description: "Discuss work",
      started_at: "2026-06-01T10:00:00Z",
      ended_at: "2026-06-01T10:30:00Z",
    });
    expect(payload?.participants).toEqual([
      { name: "Alice", email: "alice@example.com", source: "calendar" },
    ]);
    expect(payload?.speaker_identities).toEqual([
      {
        id: "speaker_1",
        label: "You",
        speaker: {
          channel: "direct_mic",
          speaker_index: null,
        },
        identity: {
          kind: "current_user",
          contact_id: null,
          email: "me@example.com",
          name: null,
        },
        source: "direct_mic_self",
      },
    ]);
    expect(payload?.transcript.segments).toEqual([
      {
        speaker_id: "speaker_1",
        started_at: new Date(100).toISOString(),
        ended_at: new Date(200).toISOString(),
        text: "hello",
      },
    ]);
  });

  it("resolves explicit speaker assignments to participant email and name", () => {
    const store = createStore(
      {
        sessions: {
          "session-1": {
            title: "Call",
          },
        },
        events: {},
        calendars: {},
        humans: {
          "human-1": {
            name: "Alice",
            email: "alice@example.com",
          },
        },
        mapping_session_participant: {
          "mapping-1": {
            session_id: "session-1",
            human_id: "human-1",
            source: "manual",
          },
        },
        transcripts: {
          "transcript-1": {
            session_id: "session-1",
            user_id: "user-1",
            created_at: "2026-06-01T10:00:00Z",
            started_at: 100,
            words: JSON.stringify([word("word-1", 1)]),
            speaker_hints: JSON.stringify([
              {
                id: "word-1:provider",
                word_id: "word-1",
                type: "provider_speaker_index",
                value: JSON.stringify({ channel: 1, speaker_index: 2 }),
              },
              {
                id: "word-1:user",
                word_id: "word-1",
                type: "user_speaker_assignment",
                value: JSON.stringify({
                  human_id: "human-1",
                  contact_id: "contact:alice",
                }),
              },
            ]),
            memo_md: "",
          },
        },
      },
      { user_id: "user-1" },
    );

    const payload = buildDigitalBrainTranscriptionPayload({
      store,
      sessionId: "session-1",
    });

    expect(payload?.speaker_identities).toEqual([
      {
        id: "speaker_1",
        label: "Alice",
        speaker: { channel: "remote_party", speaker_index: 2 },
        identity: {
          kind: "participant",
          contact_id: "contact:alice",
          email: "alice@example.com",
          name: "Alice",
        },
        source: "user_assignment",
      },
    ]);
    expect(payload?.transcript.segments[0]).toEqual({
      speaker_id: "speaker_1",
      started_at: new Date(100).toISOString(),
      ended_at: new Date(200).toISOString(),
      text: "hello",
    });
  });

  it("includes meeting identity and stable contact assignments in the transcript hash", () => {
    const buildStore = ({
      title = "Call",
      name = "Alice",
      email = "alice@example.com",
      contactId = "contact:alice",
      channel = 1,
    }: {
      title?: string;
      name?: string;
      email?: string;
      contactId?: string;
      channel?: number;
    }) =>
      createStore(
        {
          sessions: {
            "session-1": {
              title,
              created_at: "2026-06-01T09:55:00Z",
            },
          },
          events: {},
          calendars: {},
          humans: {
            "human-1": {
              name,
              email,
            },
          },
          mapping_session_participant: {
            "mapping-1": {
              session_id: "session-1",
              human_id: "human-1",
              source: "manual",
            },
          },
          transcripts: {
            "transcript-1": {
              session_id: "session-1",
              user_id: "user-1",
              created_at: "2026-06-01T10:00:00Z",
              started_at: 1780308000000,
              words: JSON.stringify([word("word-1", 1)]),
              speaker_hints: JSON.stringify([
                {
                  id: "word-1:provider",
                  word_id: "word-1",
                  type: "provider_speaker_index",
                  value: JSON.stringify({ channel, speaker_index: 2 }),
                },
                {
                  id: "word-1:user",
                  word_id: "word-1",
                  type: "user_speaker_assignment",
                  value: JSON.stringify({
                    human_id: "human-1",
                    contact_id: contactId,
                  }),
                },
              ]),
              memo_md: "",
            },
          },
        },
        { user_id: "user-1" },
      );

    const baseHash = buildDigitalBrainTranscriptionPayload({
      store: buildStore({}),
      sessionId: "session-1",
    })?.transcript_hash;
    const renamedHash = buildDigitalBrainTranscriptionPayload({
      store: buildStore({
        name: "Alice Renamed",
        email: "alice.renamed@example.com",
      }),
      sessionId: "session-1",
    })?.transcript_hash;
    const changedContactHash = buildDigitalBrainTranscriptionPayload({
      store: buildStore({ contactId: "contact:bob" }),
      sessionId: "session-1",
    })?.transcript_hash;
    const changedChannelHash = buildDigitalBrainTranscriptionPayload({
      store: buildStore({ channel: 2 }),
      sessionId: "session-1",
    })?.transcript_hash;
    const changedTitleHash = buildDigitalBrainTranscriptionPayload({
      store: buildStore({ title: "Different call" }),
      sessionId: "session-1",
    })?.transcript_hash;

    expect(renamedHash).toBe(baseHash);
    expect(changedChannelHash).toBe(baseHash);
    expect(changedContactHash).not.toBe(baseHash);
    expect(changedTitleHash).not.toBe(baseHash);
  });

  it("uses the session time and transcript duration when a session has no calendar event start", () => {
    const store = createStore(
      {
        sessions: {
          "session-1": {
            title: "Ad hoc call",
            created_at: "2026-06-01T09:55:00Z",
          },
        },
        events: {},
        calendars: {},
        humans: {},
        mapping_session_participant: {},
        transcripts: {
          "transcript-1": {
            session_id: "session-1",
            user_id: "user-1",
            created_at: "2026-06-01T10:00:00Z",
            started_at: 1780308000000,
            words: JSON.stringify([
              {
                ...word("word-1", 0),
                end_ms: 1_800_000,
              },
            ]),
            speaker_hints: "[]",
            memo_md: "",
          },
        },
      },
      { user_id: "user-1" },
    );

    const payload = buildDigitalBrainTranscriptionPayload({
      store,
      sessionId: "session-1",
    });

    expect(payload?.meeting).toMatchObject({
      original_id: "session-1",
      provider: "hyprnote",
      title: "Ad hoc call",
      started_at: "2026-06-01T09:55:00Z",
      ended_at: "2026-06-01T10:25:00.000Z",
    });
  });

  it("uses the session creation time when transcript starts are not absolute timestamps", () => {
    const store = createStore(
      {
        sessions: {
          "session-1": {
            title: "Imported call",
            created_at: "2026-06-01T09:55:00Z",
          },
        },
        events: {},
        calendars: {},
        humans: {},
        mapping_session_participant: {},
        transcripts: {
          "transcript-1": {
            session_id: "session-1",
            user_id: "user-1",
            created_at: "2026-06-01T10:00:00Z",
            started_at: 0,
            words: JSON.stringify([word("word-1", 0)]),
            speaker_hints: "[]",
            memo_md: "",
          },
        },
      },
      { user_id: "user-1" },
    );

    const payload = buildDigitalBrainTranscriptionPayload({
      store,
      sessionId: "session-1",
    });

    expect(payload?.meeting.started_at).toBe("2026-06-01T09:55:00Z");
  });

  it("identifies unassigned direct mic words as the current user", () => {
    const store = createStore(
      {
        sessions: {
          "session-1": {
            title: "Call",
          },
        },
        events: {},
        calendars: {},
        humans: {
          "user-1": {
            name: "Me",
            email: "",
          },
        },
        mapping_session_participant: {},
        transcripts: {
          "transcript-1": {
            session_id: "session-1",
            user_id: "user-1",
            created_at: "2026-06-01T10:00:00Z",
            started_at: 100,
            words: JSON.stringify([word("word-1", 0)]),
            speaker_hints: "[]",
            memo_md: "",
          },
        },
      },
      { user_id: "user-1" },
    );

    const payload = buildDigitalBrainTranscriptionPayload({
      store,
      sessionId: "session-1",
      currentUserEmail: "me@example.com",
    });

    expect(payload?.speaker_identities).toEqual([
      {
        id: "speaker_1",
        label: "You",
        speaker: { channel: "direct_mic", speaker_index: null },
        identity: {
          kind: "current_user",
          contact_id: null,
          email: "me@example.com",
          name: "Me",
        },
        source: "direct_mic_self",
      },
    ]);
  });
});
