import { useCallback } from "react";

import { commands as deeplinkCommands } from "@hypr/plugin-deeplink2";
import { commands as openerCommands } from "@hypr/plugin-opener2";
import { sonnerToast } from "@hypr/ui/components/ui/toast";

import {
  OAuthCalendarSelection,
  useOAuthCalendarSelection,
} from "./oauth/calendar-selection";

import type { CalendarProvider } from "~/calendar/components/shared";
import {
  GOOGLE_OAUTH_REDIRECT_URI_KEY,
  GOOGLE_OAUTH_VERIFIER_KEY,
} from "~/calendar/google-local";
import { env } from "~/env";
import { getScheme } from "~/shared/utils";

const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_OAUTH_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";

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

async function openGoogleCalendarOAuth() {
  const clientId = env.VITE_GOOGLE_CALENDAR_CLIENT_ID;
  if (!clientId) {
    sonnerToast.error("Missing VITE_GOOGLE_CALENDAR_CLIENT_ID");
    return;
  }

  const scheme = await getScheme();
  const server = await deeplinkCommands.startCallbackServer(scheme);
  if (server.status === "error") {
    sonnerToast.error(server.error);
    return;
  }

  const { verifier, challenge } = await createPkceChallenge();
  window.sessionStorage.setItem(GOOGLE_OAUTH_VERIFIER_KEY, verifier);

  const redirectUri = `http://127.0.0.1:${server.data}/google-calendar/callback`;
  window.sessionStorage.setItem(GOOGLE_OAUTH_REDIRECT_URI_KEY, redirectUri);

  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "google-calendar");

  const result = await openerCommands.openUrl(url.toString(), null);
  if (result.status === "error") {
    sonnerToast.error(result.error);
  }
}

export function GoogleLocalProviderContent({
  config,
}: {
  config: CalendarProvider;
}) {
  const { groups, handleRefresh, handleToggle, isLoading } =
    useOAuthCalendarSelection(config);
  const handleConnect = useCallback(() => {
    void openGoogleCalendarOAuth();
  }, []);

  if (groups.length > 0) {
    return (
      <div className="flex flex-col gap-3 pb-2">
        <OAuthCalendarSelection
          groups={groups}
          onToggle={handleToggle}
          onRefresh={handleRefresh}
          isLoading={isLoading}
        />
        <button
          type="button"
          onClick={handleConnect}
          className="cursor-pointer self-start text-xs text-neutral-600 underline transition-colors hover:text-neutral-900"
        >
          Reconnect Google Calendar
        </button>
      </div>
    );
  }

  return (
    <div className="pt-1 pb-2">
      <button
        type="button"
        onClick={handleConnect}
        className="cursor-pointer text-xs text-neutral-600 underline transition-colors hover:text-neutral-900"
      >
        Connect Google Calendar
      </button>
    </div>
  );
}
