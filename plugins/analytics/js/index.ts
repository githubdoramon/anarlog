import type {
  AnalyticsPayload,
  PropertiesPayload,
  Result,
} from "./bindings.gen";

export type {
  AnalyticsPayload,
  JsonValue,
  PropertiesPayload,
  Result,
} from "./bindings.gen";

const ok = { status: "ok", data: null } as const;

export const commands = {
  async event(_payload: AnalyticsPayload): Promise<Result<null, string>> {
    return ok;
  },
  async setProperties(
    _payload: PropertiesPayload,
  ): Promise<Result<null, string>> {
    return ok;
  },
  async setDisabled(_disabled: boolean): Promise<Result<null, string>> {
    return ok;
  },
  async isDisabled(): Promise<Result<boolean, string>> {
    return { status: "ok", data: true };
  },
  async identify(
    _userId: string,
    _payload: PropertiesPayload,
  ): Promise<Result<null, string>> {
    return ok;
  },
};
