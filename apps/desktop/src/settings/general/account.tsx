import { HardDriveIcon, LogInIcon, LogOutIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@hypr/ui/components/ui/button";
import { sonnerToast } from "@hypr/ui/components/ui/toast";

import { useAuth } from "~/auth";

export function SettingsAccount() {
  const auth = useAuth();
  const email = auth.session?.user.email;
  const [isPending, setIsPending] = useState(false);

  const handleSignIn = async () => {
    setIsPending(true);
    try {
      await auth.signIn();
    } catch (error) {
      console.error(error);
      sonnerToast.error(
        error instanceof Error ? error.message : "Failed to start sign-in",
      );
    } finally {
      setIsPending(false);
    }
  };

  const handleSignOut = async () => {
    setIsPending(true);
    try {
      await auth.signOut();
      sonnerToast.success("Signed out");
    } catch (error) {
      console.error(error);
      sonnerToast.error(
        error instanceof Error ? error.message : "Failed to sign out",
      );
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-700">
          <HardDriveIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-neutral-900">
            {email ? "Google account" : "Local account"}
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            {email
              ? "Anarlog is signed in for server integrations. Notes, settings, and local model choices remain stored on this device."
              : "Sign in with Google to send meeting transcripts to your configured server. Notes, settings, and local model choices remain stored on this device."}
          </p>
          {email ? (
            <p className="mt-3 truncate text-xs text-neutral-500">
              Signed in as {email}
            </p>
          ) : null}
        </div>
        {email ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSignOut()}
            disabled={isPending}
            className="shrink-0"
          >
            <LogOutIcon className="size-4" />
            Sign out
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void handleSignIn()}
            disabled={isPending}
            className="shrink-0"
          >
            <LogInIcon className="size-4" />
            Sign in with Google
          </Button>
        )}
      </div>
    </div>
  );
}
