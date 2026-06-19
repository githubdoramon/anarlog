import type { DigitalBrainTranscriptionPayload } from "./types";

export function getUnidentifiedSpeakerIds(
  payload: DigitalBrainTranscriptionPayload,
) {
  return payload.speaker_identities.flatMap((speaker) => {
    if (isIdentifiedSpeaker(speaker)) {
      return [];
    }
    return [speaker.id];
  });
}

function isIdentifiedSpeaker(
  speaker: DigitalBrainTranscriptionPayload["speaker_identities"][number],
) {
  if (speaker.identity.contact_id) {
    return true;
  }

  if (speaker.identity.kind === "current_user") {
    return true;
  }

  if (speaker.identity.kind === "participant") {
    return !!(speaker.identity.email?.trim() || speaker.identity.name?.trim());
  }

  return false;
}
