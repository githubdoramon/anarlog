import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { commands as authCommands } from "@hypr/plugin-auth";
import { commands as deeplinkCommands } from "@hypr/plugin-deeplink2";
import { commands as openerCommands } from "@hypr/plugin-opener2";
import { openUrlWithInstruction } from "@hypr/plugin-windows";

import { env } from "~/env";
import { getScheme } from "~/shared/utils";

export type LocalSession = {
  access_token: string;
  google_access_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_at?: number;
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
const AUTH_SESSION_KEY = "sb-anarlog-auth-token";
const GOOGLE_OAUTH_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_SCOPE = "openid email profile";
const GOOGLE_AUTH_STATE = "google-auth";
const GOOGLE_OAUTH_VERIFIER_KEY = "anarlog.googleAuthOAuth.verifier";
const GOOGLE_OAUTH_REDIRECT_URI_KEY = "anarlog.googleAuthOAuth.redirectUri";

type GoogleTokenResponse = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

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
    void loadStoredSession().then(setSession);
  }, []);

  const persistSession = useCallback(
    async (nextSession: LocalSession | null) => {
      if (nextSession) {
        const result = await authCommands.setItem(
          AUTH_SESSION_KEY,
          JSON.stringify(nextSession),
        );
        if (result.status === "error") {
          throw new Error(result.error);
        }
      } else {
        const result = await authCommands.removeItem(AUTH_SESSION_KEY);
        if (result.status === "error") {
          throw new Error(result.error);
        }
        window.localStorage.removeItem(LOCAL_SESSION_KEY);
      }

      setSession(nextSession);
    },
    [],
  );

  const signIn = useCallback(async () => {
    const clientId = getGoogleClientId();
    if (!clientId) {
      throw new Error(
        "Missing VITE_GOOGLE_AUTH_CLIENT_ID or VITE_GOOGLE_CALENDAR_CLIENT_ID",
      );
    }

    const scheme = await getScheme();
    const server = await deeplinkCommands.startCallbackServer(scheme);
    if (server.status === "error") {
      throw new Error(server.error);
    }

    const { verifier, challenge } = await createPkceChallenge();
    window.sessionStorage.setItem(GOOGLE_OAUTH_VERIFIER_KEY, verifier);

    const redirectUri = `http://127.0.0.1:${server.data}/auth/callback`;
    window.sessionStorage.setItem(GOOGLE_OAUTH_REDIRECT_URI_KEY, redirectUri);

    const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_AUTH_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", GOOGLE_AUTH_STATE);

    await openUrlWithInstruction(url.toString(), "sign-in", (u) =>
      openerCommands.openUrl(u, null),
    );
  }, []);

  const signOut = useCallback(async () => {
    await persistSession(null);
  }, [persistSession]);

  const refreshSession = useCallback(async () => {
    if (!session?.refresh_token || !isExpiredOrExpiring(session)) {
      return session;
    }

    const nextSession = await refreshGoogleSession(session);
    await persistSession(nextSession);
    return nextSession;
  }, [persistSession, session]);

  const setSessionFromTokens = useCallback(
    async (accessToken: string, refreshToken: string) => {
      const claims = await decodeClaims(accessToken);
      await persistSession({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "bearer",
        user: {
          id: claims.sub ?? "local-user",
          ...(claims.email ? { email: claims.email } : {}),
        },
      });
    },
    [persistSession],
  );

  const handleAuthCallback = useCallback(
    async (url: string) => {
      const parsed = new URL(url);
      const error = parsed.searchParams.get("error");
      if (error) {
        throw new Error(`Google sign-in failed: ${error}`);
      }

      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state");
      if (code && state === GOOGLE_AUTH_STATE) {
        const nextSession = await exchangeGoogleCodeForSession(code);
        await persistSession(nextSession);
        window.sessionStorage.removeItem(GOOGLE_OAUTH_VERIFIER_KEY);
        window.sessionStorage.removeItem(GOOGLE_OAUTH_REDIRECT_URI_KEY);
        return;
      }

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

async function loadStoredSession(): Promise<LocalSession | null> {
  const stored = await authCommands.getItem(AUTH_SESSION_KEY);
  if (stored.status === "ok" && stored.data) {
    try {
      return JSON.parse(stored.data) as LocalSession;
    } catch {
      await authCommands.removeItem(AUTH_SESSION_KEY);
    }
  }

  const raw = window.localStorage.getItem(LOCAL_SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const session = JSON.parse(raw) as LocalSession;
    const result = await authCommands.setItem(
      AUTH_SESSION_KEY,
      JSON.stringify(session),
    );
    if (result.status === "ok") {
      window.localStorage.removeItem(LOCAL_SESSION_KEY);
    }
    return session;
  } catch {
    window.localStorage.removeItem(LOCAL_SESSION_KEY);
    return null;
  }
}

async function decodeClaims(token: string) {
  const result = await authCommands.decodeClaims(token);
  if (result.status === "error") {
    throw new Error(result.error);
  }

  return result.data;
}

function getGoogleClientId() {
  return (
    env.VITE_GOOGLE_AUTH_CLIENT_ID ?? env.VITE_GOOGLE_CALENDAR_CLIENT_ID ?? null
  );
}

function getGoogleClientSecret() {
  return (
    env.VITE_GOOGLE_AUTH_CLIENT_SECRET ??
    env.VITE_GOOGLE_CALENDAR_CLIENT_SECRET ??
    null
  );
}

function base64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function createPkceChallenge() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64Url(verifierBytes);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );

  return {
    verifier,
    challenge: base64Url(challengeBytes),
  };
}

async function exchangeGoogleCodeForSession(code: string) {
  const clientId = getGoogleClientId();
  const verifier = window.sessionStorage.getItem(GOOGLE_OAUTH_VERIFIER_KEY);
  const redirectUri = window.sessionStorage.getItem(
    GOOGLE_OAUTH_REDIRECT_URI_KEY,
  );

  if (!clientId || !verifier || !redirectUri) {
    throw new Error("Missing Google sign-in state. Please try again.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const clientSecret = getGoogleClientSecret();
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google sign-in token exchange failed: ${errorText}`);
  }

  return googleTokensToSession((await response.json()) as GoogleTokenResponse);
}

async function refreshGoogleSession(session: LocalSession) {
  const clientId = getGoogleClientId();
  if (!clientId || !session.refresh_token) {
    throw new Error("Missing Google refresh credentials.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: session.refresh_token,
  });
  const clientSecret = getGoogleClientSecret();
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google sign-in token refresh failed: ${errorText}`);
  }

  return googleTokensToSession(
    (await response.json()) as GoogleTokenResponse,
    session,
  );
}

async function googleTokensToSession(
  tokens: GoogleTokenResponse,
  previous?: LocalSession,
): Promise<LocalSession> {
  const idToken = tokens.id_token;
  if (!idToken) {
    throw new Error("Google did not return an ID token.");
  }

  const claims = await decodeClaims(idToken);
  return {
    access_token: idToken,
    google_access_token: tokens.access_token ?? previous?.google_access_token,
    refresh_token: tokens.refresh_token ?? previous?.refresh_token,
    token_type: "bearer",
    expires_at: tokens.expires_in
      ? Math.floor(Date.now() / 1000) + tokens.expires_in
      : previous?.expires_at,
    user: {
      id: claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
    },
  };
}

function isExpiredOrExpiring(session: LocalSession) {
  if (!session.expires_at) {
    return false;
  }

  return session.expires_at <= Math.floor(Date.now() / 1000) + 60;
}
