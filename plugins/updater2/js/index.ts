import type {
  InstallResult,
  Result,
  UpdateDownloadFailedEvent,
  UpdateDownloadProgressEvent,
  UpdateDownloadingEvent,
  UpdateReadyEvent,
  UpdatedEvent,
} from "./bindings.gen";

export type {
  InstallResult,
  Result,
  UpdateDownloadFailedEvent,
  UpdateDownloadProgressEvent,
  UpdateDownloadingEvent,
  UpdateReadyEvent,
  UpdatedEvent,
} from "./bindings.gen";

import type { EventCallback } from "@tauri-apps/api/event";

type EventObj<T> = {
  listen: (cb: EventCallback<T>) => Promise<() => void>;
  once: (cb: EventCallback<T>) => Promise<() => void>;
  emit: (payload: T) => Promise<void>;
};

function disabledEvent<T>(): EventObj<T> {
  return {
    listen: () => Promise.resolve(() => {}),
    once: () => Promise.resolve(() => {}),
    emit: async () => {},
  };
}

export const commands = {
  async check(): Promise<Result<string | null, string>> {
    return { status: "ok", data: null };
  },
  async download(_version: string): Promise<Result<null, string>> {
    return { status: "ok", data: null };
  },
  async install(_version: string): Promise<Result<InstallResult, string>> {
    return { status: "error", error: "Updates are disabled in this build." };
  },
  async postinstall(_result: InstallResult): Promise<Result<null, string>> {
    return { status: "ok", data: null };
  },
  async maybeEmitUpdated(): Promise<void> {},
};

export const events = {
  updateDownloadFailedEvent: disabledEvent<UpdateDownloadFailedEvent>(),
  updateDownloadProgressEvent: disabledEvent<UpdateDownloadProgressEvent>(),
  updateDownloadingEvent: disabledEvent<UpdateDownloadingEvent>(),
  updateReadyEvent: disabledEvent<UpdateReadyEvent>(),
  updatedEvent: disabledEvent<UpdatedEvent>(),
};
