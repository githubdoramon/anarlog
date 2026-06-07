export type DigitalBrainUploadStatus =
  | "pending"
  | "config_missing"
  | "auth_required"
  | "sent"
  | "failed";

export type DigitalBrainParticipant = {
  name: string | null;
  email: string | null;
  source: "calendar" | "session";
};

export type DigitalBrainSpeakerIdentity = {
  id: string;
  label: string;
  speaker: {
    channel: "direct_mic" | "remote_party" | "mixed_capture";
    speaker_index: number | null;
  };
  identity: {
    kind: "current_user" | "participant" | "unknown";
    contact_id: string | null;
    email: string | null;
    name: string | null;
  };
  source:
    | "direct_mic_self"
    | "user_assignment"
    | "voice_auto_assignment"
    | "inferred_channel"
    | "unknown";
};

export type DigitalBrainTranscriptSegment = {
  speaker_id: string;
  started_at: string | null;
  ended_at: string | null;
  text: string;
};

export type DigitalBrainTranscriptionPayload = {
  upload_id: string;
  session_id: string;
  transcript_hash: string;
  meeting: {
    original_id: string | null;
    provider: "google" | "apple" | "outlook" | "hyprnote" | null;
    title: string;
    description: string | null;
    started_at: string | null;
    ended_at: string | null;
  };
  participants: DigitalBrainParticipant[];
  speaker_identities: DigitalBrainSpeakerIdentity[];
  transcript: {
    segments: DigitalBrainTranscriptSegment[];
  };
};
