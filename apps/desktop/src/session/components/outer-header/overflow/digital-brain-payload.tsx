import { useMutation } from "@tanstack/react-query";
import { downloadDir, join } from "@tauri-apps/api/path";
import { BrainCircuitIcon, Loader2Icon } from "lucide-react";

import { commands as fs2Commands } from "@hypr/plugin-fs2";
import { commands as openerCommands } from "@hypr/plugin-opener2";
import { DropdownMenuItem } from "@hypr/ui/components/ui/dropdown-menu";
import { sonnerToast } from "@hypr/ui/components/ui/toast";

import { useAuth } from "~/auth";
import {
  buildDigitalBrainTranscriptionPayload,
  getServerUrl,
} from "~/services/meeting-transcript-upload";
import * as main from "~/store/tinybase/store/main";

export function DownloadDigitalBrainPayload({
  sessionId,
  hasTranscript,
}: {
  sessionId: string;
  hasTranscript: boolean;
}) {
  const store = main.UI.useStore(main.STORE_ID);
  const auth = useAuth();
  const shouldRender = !getServerUrl();

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      if (!store) {
        throw new Error("Store is not ready.");
      }

      const payload = buildDigitalBrainTranscriptionPayload({
        store,
        sessionId,
        currentUserEmail: auth.session?.user.email,
      });
      if (!payload) {
        throw new Error("No transcript payload is available.");
      }

      const downloadsPath = await downloadDir();
      const path = await join(
        downloadsPath,
        `digital-brain-transcription-payload-${sessionId}.json`,
      );
      const result = await fs2Commands.writeTextFile(
        path,
        `${JSON.stringify(payload, null, 2)}\n`,
      );
      if (result.status === "error") {
        throw new Error(result.error);
      }

      return path;
    },
    onSuccess: (path) => {
      sonnerToast.success("Digital Brain payload downloaded");
      void openerCommands.revealItemInDir(path);
    },
    onError: (error) => {
      console.error(error);
      sonnerToast.error(
        error instanceof Error
          ? error.message
          : "Failed to download Digital Brain payload",
      );
    },
  });

  if (!shouldRender) {
    return null;
  }

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        mutate(undefined);
      }}
      disabled={!hasTranscript || isPending}
      className="cursor-pointer"
    >
      {isPending ? (
        <Loader2Icon className="animate-spin" />
      ) : (
        <BrainCircuitIcon />
      )}
      <span>
        {isPending ? "Preparing payload..." : "Download Digital Brain payload"}
      </span>
    </DropdownMenuItem>
  );
}
