import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TaskManager } from "./task-manager";

const {
  calendarChangedListenMock,
  scheduleCalendarSyncMock,
  syncCalendarEventsMock,
  useMainQueriesMock,
  useMainStoreMock,
  useScheduleTaskRunCallbackMock,
  useScheduleTaskRunMock,
  useSetTaskMock,
  useSettingsStoreMock,
} = vi.hoisted(() => ({
  calendarChangedListenMock: vi.fn(),
  scheduleCalendarSyncMock: vi.fn(),
  syncCalendarEventsMock: vi.fn(),
  useMainQueriesMock: vi.fn(),
  useMainStoreMock: vi.fn(),
  useScheduleTaskRunCallbackMock: vi.fn(),
  useScheduleTaskRunMock: vi.fn(),
  useSetTaskMock: vi.fn(),
  useSettingsStoreMock: vi.fn(),
}));

vi.mock("tinytick/ui-react", () => ({
  useScheduleTaskRun: useScheduleTaskRunMock,
  useScheduleTaskRunCallback: useScheduleTaskRunCallbackMock,
  useSetTask: useSetTaskMock,
}));

vi.mock("@hypr/plugin-calendar", () => ({
  events: {
    calendarChangedEvent: {
      listen: calendarChangedListenMock,
    },
  },
}));

vi.mock("./calendar", () => ({
  CALENDAR_SYNC_TASK_ID: "calendarSync",
  syncCalendarEvents: syncCalendarEventsMock,
}));

vi.mock("./audio-retention", () => ({
  AUDIO_RETENTION_INTERVAL: 24 * 60 * 60 * 1000,
  AUDIO_RETENTION_TASK_ID: "audioRetention",
  cleanupExpiredAudio: vi.fn(),
}));

vi.mock("./event-notification", () => ({
  EVENT_NOTIFICATION_INTERVAL: 60_000,
  EVENT_NOTIFICATION_TASK_ID: "eventNotification",
  checkEventNotifications: vi.fn(),
}));

vi.mock("~/store/tinybase/store/main", () => ({
  STORE_ID: "main-store",
  UI: {
    useQueries: useMainQueriesMock,
    useStore: useMainStoreMock,
  },
}));

vi.mock("~/store/tinybase/store/settings", () => ({
  STORE_ID: "settings-store",
  UI: {
    useStore: useSettingsStoreMock,
  },
}));

describe("TaskManager", () => {
  beforeEach(() => {
    calendarChangedListenMock.mockReset();
    scheduleCalendarSyncMock.mockReset();
    syncCalendarEventsMock.mockReset();
    useMainQueriesMock.mockReset();
    useMainStoreMock.mockReset();
    useScheduleTaskRunCallbackMock.mockReset();
    useScheduleTaskRunMock.mockReset();
    useSetTaskMock.mockReset();
    useSettingsStoreMock.mockReset();

    calendarChangedListenMock.mockResolvedValue(() => {});
    syncCalendarEventsMock.mockResolvedValue(undefined);
    useMainQueriesMock.mockReturnValue({ queries: true });
    useMainStoreMock.mockReturnValue({ store: true });
    useScheduleTaskRunCallbackMock.mockReturnValue(scheduleCalendarSyncMock);
    useSettingsStoreMock.mockReturnValue({ settingsStore: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("keeps calendar sync scheduled with a longer task timeout", () => {
    render(<TaskManager />);

    expect(useSetTaskMock).toHaveBeenCalledWith(
      "calendarSync",
      expect.any(Function),
      [{ store: true }, { queries: true }, { settingsStore: true }],
      undefined,
      { maxDuration: 5 * 60 * 1000 },
    );
    expect(useScheduleTaskRunMock).toHaveBeenCalledWith(
      "calendarSync",
      undefined,
      0,
      { repeatDelay: 60 * 1000 },
    );
  });

  test("calendar sync task resolves after a failed sync run", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    syncCalendarEventsMock.mockRejectedValueOnce(new Error("sync failed"));

    render(<TaskManager />);

    const calendarTask = useSetTaskMock.mock.calls.find(
      ([taskId]) => taskId === "calendarSync",
    )?.[1];
    expect(calendarTask).toBeTypeOf("function");

    await expect(calendarTask()).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[calendar-sync] Error running calendar sync:",
      expect.any(Error),
    );
  });
});
