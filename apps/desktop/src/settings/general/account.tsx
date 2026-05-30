import { HardDriveIcon } from "lucide-react";

import { useAuth } from "~/auth";

export function SettingsAccount() {
  const auth = useAuth();
  const email = auth.session?.user.email;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-700">
          <HardDriveIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-neutral-900">
            Local account
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Anarlog is running in local-first mode. Notes, settings, and local
            model choices are stored on this device.
          </p>
          {email ? (
            <p className="mt-3 truncate text-xs text-neutral-500">
              Cached session: {email}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
