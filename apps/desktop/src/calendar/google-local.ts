import type { Store } from "tinybase/with-schemas";

import { commands as store2Commands } from "@hypr/plugin-store2";
import { sonnerToast } from "@hypr/ui/components/ui/toast";

import { findCalendarByTrackingId } from "~/calendar/utils";
import { env } from "~/env";
import { DEFAULT_USER_ID } from "~/shared/utils";
import type { Schemas } from "~/store/tinybase/store/main";

export const GOOGLE_LOCAL_CONNECTION_ID = "google-local";
export const GOOGLE_OAUTH_REDIRECT_URI_KEY =
  "anarlog.googleCalendarOAuth.redirectUri";
export const GOOGLE_OAUTH_TOKENS_KEY = "anarlog.googleCalendarOAuth.tokens";
export const GOOGLE_OAUTH_VERIFIER_KEY = "anarlog.googleCalendarOAuth.verifier";
const GOOGLE_STORE_SCOPE = "google-calendar";
const GOOGLE_TOKENS_KEY = "tokens";

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
};

type StoredGoogleTokens = GoogleTokenResponse & {
  expires_at: number | null;
};

type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  primary?: boolean;
  accessRole?: string;
};

type GoogleCalendarListResponse = {
  items?: GoogleCalendarListEntry[];
};

type GoogleEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleEventAttendee = {
  email?: string;
  displayName?: string;
  self?: boolean;
};

type GoogleEventPerson = {
  email?: string;
  displayName?: string;
  self?: boolean;
};

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  organizer?: GoogleEventPerson;
  attendees?: GoogleEventAttendee[];
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
};

type GoogleEventsResponse = {
  items?: GoogleEvent[];
};

async function storeTokens(tokens: GoogleTokenResponse) {
  const stored: StoredGoogleTokens = {
    ...tokens,
    expires_at: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : null,
  };

  await store2Commands.setStr(
    GOOGLE_STORE_SCOPE,
    GOOGLE_TOKENS_KEY,
    JSON.stringify(stored),
  );
  await store2Commands.save();
  window.localStorage.removeItem(GOOGLE_OAUTH_TOKENS_KEY);
}

export async function hasGoogleCalendarConnection() {
  const stored = await store2Commands.getStr(
    GOOGLE_STORE_SCOPE,
    GOOGLE_TOKENS_KEY,
  );
  if (stored.status === "ok" && stored.data) {
    return true;
  }

  const legacy = window.localStorage.getItem(GOOGLE_OAUTH_TOKENS_KEY);
  if (!legacy) {
    return false;
  }

  await store2Commands.setStr(GOOGLE_STORE_SCOPE, GOOGLE_TOKENS_KEY, legacy);
  await store2Commands.save();
  window.localStorage.removeItem(GOOGLE_OAUTH_TOKENS_KEY);
  return true;
}

async function loadStoredTokens(): Promise<StoredGoogleTokens | null> {
  const stored = await store2Commands.getStr(
    GOOGLE_STORE_SCOPE,
    GOOGLE_TOKENS_KEY,
  );
  if (stored.status !== "ok" || !stored.data) {
    return null;
  }

  try {
    return JSON.parse(stored.data) as StoredGoogleTokens;
  } catch {
    return null;
  }
}

export async function getGoogleCalendarAccessToken() {
  const stored = await loadStoredTokens();
  if (!stored) {
    throw new Error("Google Calendar is not connected");
  }

  if (!stored.expires_at || stored.expires_at > Date.now() + 60_000) {
    return stored.access_token;
  }

  if (!stored.refresh_token) {
    throw new Error("Google Calendar refresh token is missing");
  }

  const clientId = env.VITE_GOOGLE_CALENDAR_CLIENT_ID;
  if (!clientId) {
    throw new Error("Missing VITE_GOOGLE_CALENDAR_CLIENT_ID");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
  });
  const clientSecret = env.VITE_GOOGLE_CALENDAR_CLIENT_SECRET;
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[google-calendar] token refresh failed", {
      status: response.status,
      body: errorText,
    });
    throw new Error(
      `Google token refresh failed: ${response.status} ${errorText}`,
    );
  }

  const refreshed = (await response.json()) as GoogleTokenResponse;
  const next = {
    ...stored,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? stored.refresh_token,
  };
  await storeTokens(next);
  return next.access_token;
}

export async function connectGoogleCalendarFromCode({
  code,
  store,
}: {
  code: string;
  store: Store<Schemas>;
}) {
  const clientId = env.VITE_GOOGLE_CALENDAR_CLIENT_ID;
  const verifier = window.sessionStorage.getItem(GOOGLE_OAUTH_VERIFIER_KEY);
  const redirectUri = window.sessionStorage.getItem(
    GOOGLE_OAUTH_REDIRECT_URI_KEY,
  );

  if (!clientId || !verifier || !redirectUri) {
    throw new Error("Missing local Google OAuth state. Please reconnect.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const clientSecret = env.VITE_GOOGLE_CALENDAR_CLIENT_SECRET;
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("[google-calendar] token exchange failed", {
      status: tokenResponse.status,
      body: errorText,
    });
    throw new Error(
      `Google token exchange failed: ${tokenResponse.status} ${errorText}`,
    );
  }

  const tokens = (await tokenResponse.json()) as GoogleTokenResponse;
  await storeTokens(tokens);
  await syncGoogleCalendarList(store, tokens.access_token);

  window.sessionStorage.removeItem(GOOGLE_OAUTH_VERIFIER_KEY);
  window.sessionStorage.removeItem(GOOGLE_OAUTH_REDIRECT_URI_KEY);
}

async function syncGoogleCalendarList(
  store: Store<Schemas>,
  accessToken: string,
) {
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Google calendar list failed: ${response.status}`);
  }

  const data = (await response.json()) as GoogleCalendarListResponse;
  const calendars = data.items ?? [];
  const userId = String(store.getValue("user_id") ?? DEFAULT_USER_ID);

  store.transaction(() => {
    for (const calendar of calendars) {
      const existingRowId = findCalendarByTrackingId(store, {
        provider: "google",
        connectionId: GOOGLE_LOCAL_CONNECTION_ID,
        trackingId: calendar.id,
      });
      const rowId = existingRowId ?? crypto.randomUUID();
      const existing = existingRowId
        ? store.getRow("calendars", existingRowId)
        : null;

      store.setRow("calendars", rowId, {
        user_id: userId,
        created_at: existing?.created_at || new Date().toISOString(),
        tracking_id_calendar: calendar.id,
        name: calendar.summaryOverride || calendar.summary || "Untitled",
        enabled: existing?.enabled ?? calendar.primary === true,
        provider: "google",
        source: calendar.primary ? calendar.id : "Google",
        color: calendar.backgroundColor || "#4285f4",
        connection_id: GOOGLE_LOCAL_CONNECTION_ID,
      });
    }
  });

  sonnerToast.success("Google Calendar connected");
}

export async function listGoogleLocalEvents({
  calendarId,
  from,
  to,
}: {
  calendarId: string;
  from: Date;
  to: Date;
}) {
  const accessToken = await getGoogleCalendarAccessToken();
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.searchParams.set("timeMin", from.toISOString());
  url.searchParams.set("timeMax", to.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("showDeleted", "false");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[google-calendar] events fetch failed", {
      status: response.status,
      body: errorText,
    });
    throw new Error(
      `Google events fetch failed: ${response.status} ${errorText}`,
    );
  }

  const data = (await response.json()) as GoogleEventsResponse;
  return (data.items ?? []).filter((event) => event.status !== "cancelled");
}

export type { GoogleEvent };
