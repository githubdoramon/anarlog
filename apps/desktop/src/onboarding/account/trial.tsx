import { useEffect } from "react";

export type TrialPhase =
  | "checking"
  | "starting"
  | "already-paid"
  | "already-trialing"
  | { done: "started" | "not_eligible" | "error" };

export function useTrialFlow(onContinue: () => void) {
  useEffect(() => {
    onContinue();
  }, [onContinue]);

  return { done: "not_eligible" } as const;
}
