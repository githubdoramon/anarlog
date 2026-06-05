import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingActionButton } from "./index";

import type { Tab } from "~/store/zustand/tabs/schema";

const { startListeningMock, useHasTranscriptMock, useListenerMock } =
  vi.hoisted(() => ({
    startListeningMock: vi.fn(),
    useHasTranscriptMock: vi.fn(),
    useListenerMock: vi.fn(),
  }));

vi.mock("~/session/components/shared", () => ({
  useCurrentNoteTab: vi.fn(() => ({ type: "raw" })),
  useHasTranscript: useHasTranscriptMock,
}));

vi.mock("~/shared/chat-cta", () => ({
  ChatCTA: () => <button type="button">Ask about this session</button>,
}));

vi.mock("~/stt/contexts", () => ({
  useListener: useListenerMock,
}));

vi.mock("~/stt/useStartListening", () => ({
  useStartListening: vi.fn(() => startListeningMock),
}));

const tab = {
  type: "sessions",
  id: "session-1",
  state: { view: null, autoStart: null },
} as Extract<Tab, { type: "sessions" }>;

describe("FloatingActionButton", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useHasTranscriptMock.mockReturnValue(true);
    useListenerMock.mockImplementation((selector) =>
      selector({
        getSessionMode: vi.fn(() => "inactive"),
        canStartLiveSession: vi.fn(() => true),
      }),
    );
  });

  it("renders resume listening above the session chat CTA", () => {
    render(<FloatingActionButton tab={tab} />);

    const resume = screen.getByRole("button", { name: "Resume listening" });
    const ask = screen.getByRole("button", {
      name: "Ask about this session",
    });

    expect(resume.compareDocumentPosition(ask)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(resume);

    expect(startListeningMock).toHaveBeenCalledTimes(1);
  });

  it("disables resume listening when live capture cannot start", () => {
    useListenerMock.mockImplementation((selector) =>
      selector({
        getSessionMode: vi.fn(() => "inactive"),
        canStartLiveSession: vi.fn(() => false),
      }),
    );

    render(<FloatingActionButton tab={tab} />);

    const resume = screen.getByRole("button", { name: "Resume listening" });
    expect(resume).toHaveProperty("disabled", true);

    fireEvent.click(resume);

    expect(startListeningMock).not.toHaveBeenCalled();
  });
});
