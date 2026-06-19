import { describe, expect, it } from "vitest";

import { getUnidentifiedSpeakerIds } from "./identity";
import type { DigitalBrainTranscriptionPayload } from "./types";

function payloadWithSpeakers(
  speaker_identities: DigitalBrainTranscriptionPayload["speaker_identities"],
): DigitalBrainTranscriptionPayload {
  return {
    upload_id: "upload-1",
    session_id: "session-1",
    transcript_hash: "hash-1",
    meeting: {
      original_id: "session-1",
      provider: "hyprnote",
      title: "Call",
      description: null,
      started_at: null,
      ended_at: null,
    },
    participants: [],
    speaker_identities,
    transcript: {
      segments: [],
    },
  };
}

describe("getUnidentifiedSpeakerIds", () => {
  it("accepts current users and named or emailed participants without contact ids", () => {
    const payload = payloadWithSpeakers([
      {
        id: "speaker_1",
        label: "You",
        speaker: { channel: "direct_mic", speaker_index: null },
        identity: {
          kind: "current_user",
          contact_id: null,
          email: "me@example.com",
          name: null,
        },
        source: "direct_mic_self",
      },
      {
        id: "speaker_2",
        label: "Victor Dias",
        speaker: { channel: "remote_party", speaker_index: 1 },
        identity: {
          kind: "participant",
          contact_id: null,
          email: null,
          name: "Victor Dias",
        },
        source: "user_assignment",
      },
    ]);

    expect(getUnidentifiedSpeakerIds(payload)).toEqual([]);
  });

  it("still reports unknown speakers", () => {
    const payload = payloadWithSpeakers([
      {
        id: "speaker_1",
        label: "Speaker 1",
        speaker: { channel: "remote_party", speaker_index: 0 },
        identity: {
          kind: "unknown",
          contact_id: null,
          email: null,
          name: null,
        },
        source: "unknown",
      },
    ]);

    expect(getUnidentifiedSpeakerIds(payload)).toEqual(["speaker_1"]);
  });
});
