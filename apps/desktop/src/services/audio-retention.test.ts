import { describe, expect, test } from "vitest";

import {
  AUDIO_RETENTION_MIN_DELETE_AGE_MS,
  normalizeAudioRetention,
  sessionAudioExpired,
} from "./audio-retention";

describe("audio retention", () => {
  test("normalizes current and legacy values", () => {
    expect(normalizeAudioRetention("none")).toBe("none");
    expect(normalizeAudioRetention("oneWeek")).toBe("oneWeek");
    expect(normalizeAudioRetention(false)).toBe("none");
    expect(normalizeAudioRetention(true)).toBe("oneMonth");
    expect(normalizeAudioRetention("invalid")).toBe("oneMonth");
    expect(normalizeAudioRetention("invalid", undefined)).toBeUndefined();
  });

  test("does not delete fresh audio even when retention is none", () => {
    const now = Date.parse("2026-05-13T00:00:00.000Z");

    expect(sessionAudioExpired("2026-05-12T23:30:00.000Z", "none", now)).toBe(
      false,
    );
    expect(
      sessionAudioExpired(
        new Date(now - AUDIO_RETENTION_MIN_DELETE_AGE_MS - 1).toISOString(),
        "none",
        now,
      ),
    ).toBe(true);
  });

  test("expires after the selected retention window", () => {
    const now = Date.parse("2026-05-13T00:00:00.000Z");

    expect(sessionAudioExpired("2026-05-11T23:59:59.999Z", "oneDay", now)).toBe(
      true,
    );
    expect(sessionAudioExpired("2026-05-12T00:00:00.001Z", "oneDay", now)).toBe(
      false,
    );
  });

  test("does not expire sessions with invalid creation dates", () => {
    expect(sessionAudioExpired(null, "oneDay")).toBe(false);
    expect(sessionAudioExpired("not-a-date", "oneDay")).toBe(false);
  });
});
