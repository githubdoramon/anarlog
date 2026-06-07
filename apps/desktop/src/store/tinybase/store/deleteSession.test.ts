import { beforeEach, describe, expect, it, vi } from "vitest";

const fsSyncMocks = vi.hoisted(() => ({
  audioDelete: vi.fn(),
  deleteSessionFolder: vi.fn(),
}));

vi.mock("@hypr/plugin-fs-sync", () => ({
  commands: fsSyncMocks,
}));

import { deleteSessionCascade } from "./deleteSession";

describe("deleteSessionCascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the persisted session folder by default", () => {
    const store = {
      delRow: vi.fn(),
    };

    deleteSessionCascade(store as never, undefined, "session-1");

    expect(store.delRow).toHaveBeenCalledWith("sessions", "session-1");
    expect(fsSyncMocks.deleteSessionFolder).toHaveBeenCalledWith("session-1");
    expect(fsSyncMocks.audioDelete).not.toHaveBeenCalled();
  });

  it("keeps persisted files when deletion is pending undo", () => {
    const store = {
      delRow: vi.fn(),
    };

    deleteSessionCascade(store as never, undefined, "session-1", {
      skipAudio: true,
    });

    expect(store.delRow).toHaveBeenCalledWith("sessions", "session-1");
    expect(fsSyncMocks.deleteSessionFolder).not.toHaveBeenCalled();
    expect(fsSyncMocks.audioDelete).not.toHaveBeenCalled();
  });
});
