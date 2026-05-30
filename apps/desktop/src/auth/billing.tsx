import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";

type BillingInfo = {
  entitlements: string[];
  subscriptionStatus: string | null;
  isPro: boolean;
  isLite: boolean;
  isPaid: boolean;
  isTrialing: boolean;
  trialEnd: string | null;
  trialDaysRemaining: number | null;
  plan: "free";
};

type BillingContextValue = BillingInfo & {
  isReady: boolean;
  canStartTrial: { data: boolean; isPending: boolean };
  upgradeToPro: () => void;
};

export type BillingAccess = BillingContextValue;

const BillingContext = createContext<BillingContextValue | null>(null);

const LOCAL_BILLING: BillingInfo = {
  entitlements: [],
  subscriptionStatus: null,
  isPro: false,
  isLite: false,
  isPaid: false,
  isTrialing: false,
  trialEnd: null,
  trialDaysRemaining: null,
  plan: "free",
};

export function BillingProvider({ children }: { children: ReactNode }) {
  const upgradeToPro = useCallback(() => {}, []);

  const value = useMemo<BillingContextValue>(
    () => ({
      ...LOCAL_BILLING,
      isReady: true,
      canStartTrial: { data: false, isPending: false },
      upgradeToPro,
    }),
    [upgradeToPro],
  );

  return (
    <BillingContext.Provider value={value}>{children}</BillingContext.Provider>
  );
}

export function useBillingAccess() {
  const context = useContext(BillingContext);

  if (!context) {
    throw new Error("useBillingAccess must be used within BillingProvider");
  }

  return context;
}
