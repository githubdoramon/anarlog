import { useQuery } from "@tanstack/react-query";

import type { ConnectionItem } from "@hypr/api-client";

import { hasGoogleCalendarConnection } from "~/calendar/google-local";

export function useConnections(enabled = true) {
  return useQuery({
    queryKey: ["integration-status", "local"],
    queryFn: async (): Promise<ConnectionItem[]> =>
      (await hasGoogleCalendarConnection())
        ? [
            {
              integration_id: "google-calendar",
              connection_id: "google-local",
              status: "connected",
              last_error_description: null,
            },
          ]
        : [],
    enabled,
  });
}
