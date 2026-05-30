import {
  createContext,
  useEffect,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export type LocalSession = {
  access_token: string;
  token_type: string;
  user: {
    id: string;
    email?: string;
  };
};

type AuthState = {
  supabase: null;
  session: LocalSession | null;
  isRefreshingSession: false;
};

type AuthActions = {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<LocalSession | null>;
};

type AuthTokenHandlers = {
  handleAuthCallback: (_url: string) => Promise<void>;
  setSessionFromTokens: (
    _accessToken: string,
    _refreshToken: string,
  ) => Promise<void>;
};

type AuthUtils = {
  getHeaders: () => { Authorization: string } | null;
  getAvatarUrl: () => Promise<string | null>;
};

export type AuthContextType = AuthState &
  AuthActions &
  AuthTokenHandlers &
  AuthUtils;

const AuthContext = createContext<AuthContextType | null>(null);
const LOCAL_SESSION_KEY = "anarlog.local.auth.session";

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("'useAuth' must be used within an 'AuthProvider'");
  }

  return context;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<LocalSession | null>(null);

  useEffect(() => {
    const raw = window.localStorage.getItem(LOCAL_SESSION_KEY);
    if (!raw) return;

    try {
      setSession(JSON.parse(raw) as LocalSession);
    } catch {
      window.localStorage.removeItem(LOCAL_SESSION_KEY);
    }
  }, []);

  const persistSession = useCallback((nextSession: LocalSession | null) => {
    setSession(nextSession);

    if (nextSession) {
      window.localStorage.setItem(
        LOCAL_SESSION_KEY,
        JSON.stringify(nextSession),
      );
    } else {
      window.localStorage.removeItem(LOCAL_SESSION_KEY);
    }
  }, []);

  const signIn = useCallback(async () => {}, []);

  const signOut = useCallback(async () => {
    persistSession(null);
  }, [persistSession]);

  const refreshSession = useCallback(async () => session, [session]);

  const setSessionFromTokens = useCallback(
    async (accessToken: string, _refreshToken: string) => {
      persistSession({
        access_token: accessToken,
        token_type: "bearer",
        user: {
          id: "local-user",
        },
      });
    },
    [persistSession],
  );

  const handleAuthCallback = useCallback(
    async (url: string) => {
      const parsed = new URL(url);
      const accessToken = parsed.searchParams.get("access_token");
      const refreshToken = parsed.searchParams.get("refresh_token");

      if (accessToken && refreshToken) {
        await setSessionFromTokens(accessToken, refreshToken);
      }
    },
    [setSessionFromTokens],
  );

  const getHeaders = useCallback(
    () =>
      session
        ? {
            Authorization: `Bearer ${session.access_token}`,
          }
        : null,
    [session],
  );

  const getAvatarUrl = useCallback(async () => null, []);

  const value = useMemo<AuthContextType>(
    () => ({
      session,
      supabase: null,
      signIn,
      signOut,
      refreshSession,
      isRefreshingSession: false,
      handleAuthCallback,
      setSessionFromTokens,
      getHeaders,
      getAvatarUrl,
    }),
    [
      session,
      signIn,
      signOut,
      refreshSession,
      handleAuthCallback,
      setSessionFromTokens,
      getHeaders,
      getAvatarUrl,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
