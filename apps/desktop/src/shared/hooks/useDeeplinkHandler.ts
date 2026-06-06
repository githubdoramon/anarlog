import { useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useScheduleTaskRunCallback } from "tinytick/ui-react";

import { events as deeplink2Events } from "@hypr/plugin-deeplink2";
import { dismissInstruction } from "@hypr/plugin-windows";
import { sonnerToast } from "@hypr/ui/components/ui/toast";

import { useAuth } from "~/auth";
import { connectGoogleCalendarFromCode } from "~/calendar/google-local";
import { CALENDAR_SYNC_TASK_ID } from "~/services/calendar";
import * as main from "~/store/tinybase/store/main";
import { useTabs } from "~/store/zustand/tabs";

export function useDeeplinkHandler() {
  const auth = useAuth();
  const store = main.UI.useStore(main.STORE_ID);
  const queryClient = useQueryClient();
  const openNew = useTabs((state) => state.openNew);
  const scheduleCalendarSync = useScheduleTaskRunCallback(
    CALENDAR_SYNC_TASK_ID,
    undefined,
    0,
  );

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const timeoutIds = new Set<number>();
    const refreshIntegrationState = () => {
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "integration-status",
      });
      scheduleCalendarSync();
    };

    const unlisten = deeplink2Events.deepLinkEvent.listen(({ payload }) => {
      if (payload.to === "/auth/callback") {
        const { access_token, refresh_token, code, error } = payload.search;
        if (error) {
          sonnerToast.error(`Sign-in failed: ${error}`);
          return;
        }

        if (access_token && refresh_token && auth) {
          void auth
            .setSessionFromTokens(access_token, refresh_token)
            .then(() => dismissInstruction());
        } else if (code && auth) {
          void auth
            .handleAuthCallback(
              `${window.location.origin}/auth/callback?${new URLSearchParams(
                Object.entries(payload.search).flatMap(([key, value]) =>
                  value ? [[key, value]] : [],
                ),
              ).toString()}`,
            )
            .then(() => dismissInstruction())
            .catch((e) => {
              console.error("[deeplink] auth callback failed", e);
              sonnerToast.error(
                e instanceof Error ? e.message : "Failed to complete sign-in",
              );
            });
        }
      } else if (payload.to === "/billing/refresh") {
        if (auth) {
          void auth.refreshSession();
        }
        void dismissInstruction();
      } else if (payload.to === "/google-calendar/callback") {
        const { code, error } = payload.search;
        console.log("[deeplink] google calendar callback received", {
          hasCode: !!code,
          error,
        });

        if (error) {
          sonnerToast.error(`Google Calendar authorization failed: ${error}`);
          return;
        }

        if (!code || !store) {
          sonnerToast.error("Google Calendar authorization was incomplete");
          return;
        }

        void connectGoogleCalendarFromCode({ code, store })
          .then(() => {
            void queryClient.invalidateQueries({
              predicate: (query) => query.queryKey[0] === "integration-status",
            });
            openNew({ type: "calendar" });
          })
          .catch((e) => {
            console.error("[deeplink] google calendar connect failed", e);
            sonnerToast.error(
              e instanceof Error
                ? e.message
                : "Failed to connect Google Calendar",
            );
          });
      } else if (payload.to === "/integration/callback") {
        const { integration_id, status, return_to } = payload.search;
        if (status === "success") {
          console.log(`[deeplink] integration updated: ${integration_id}`);
          refreshIntegrationState();
          for (const delay of [1000, 3000]) {
            const timeoutId = window.setTimeout(() => {
              timeoutIds.delete(timeoutId);
              refreshIntegrationState();
            }, delay);
            timeoutIds.add(timeoutId);
          }

          void dismissInstruction().then(() => {
            if (return_to === "calendar" || return_to === "settings-calendar") {
              openNew({ type: "calendar" });
            } else if (return_to === "todo") {
              openNew({ type: "settings", state: { tab: "todo" } });
            }
          });
        }
      }
    });

    return () => {
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      void unlisten.then((fn) => fn());
    };
  }, [auth, openNew, queryClient, scheduleCalendarSync, store]);
}
