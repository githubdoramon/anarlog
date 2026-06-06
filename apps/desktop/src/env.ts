import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_APP_URL: z.string().min(1).default("http://localhost:3000"),
    VITE_DIGITAL_BRAIN_SERVER_URL: z.string().min(1).optional(),
    VITE_GOOGLE_AUTH_CLIENT_ID: z.string().min(1).optional(),
    VITE_GOOGLE_AUTH_CLIENT_SECRET: z.string().min(1).optional(),
    VITE_GOOGLE_CALENDAR_CLIENT_ID: z.string().min(1).optional(),
    VITE_GOOGLE_CALENDAR_CLIENT_SECRET: z.string().min(1).optional(),
    VITE_PRO_PRODUCT_ID: z.string().min(1).optional(),
    VITE_APP_VERSION: z.string().min(1).optional(),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});
