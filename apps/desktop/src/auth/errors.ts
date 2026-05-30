import { commands as authCommands } from "@hypr/plugin-auth";

export const isFatalSessionError = (error: unknown): boolean => {
  void error;
  return false;
};

export const clearAuthStorage = async (): Promise<void> => {
  try {
    await authCommands.clear();
  } catch {
    // Ignore storage errors
  }
};
