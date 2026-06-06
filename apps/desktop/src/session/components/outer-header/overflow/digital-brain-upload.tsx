import { useMutation } from "@tanstack/react-query";
import { BrainCircuitIcon, Loader2Icon } from "lucide-react";

import { DropdownMenuItem } from "@hypr/ui/components/ui/dropdown-menu";
import { sonnerToast } from "@hypr/ui/components/ui/toast";

import { useAuth } from "~/auth";
import {
  getMeetingTranscriptUploadService,
  getServerUrl,
} from "~/services/meeting-transcript-upload";

export function UploadDigitalBrainPayload({
  sessionId,
  hasTranscript,
}: {
  sessionId: string;
  hasTranscript: boolean;
}) {
  const auth = useAuth();
  const hasServerUrl = !!getServerUrl();

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      if (!hasServerUrl) {
        throw new Error("Digital Brain server URL is not configured.");
      }

      const service = getMeetingTranscriptUploadService();
      if (!service) {
        throw new Error("Digital Brain upload service is not ready.");
      }

      const payload = await service.forceUploadSession(sessionId);
      if (!payload) {
        throw new Error("No transcript payload is available.");
      }

      return payload;
    },
    onSuccess: () => {
      sonnerToast.success("Digital Brain upload queued");
    },
    onError: (error) => {
      console.error(error);
      sonnerToast.error(
        error instanceof Error
          ? error.message
          : "Failed to queue Digital Brain upload",
      );
    },
  });

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        if (!auth.session) {
          void auth.signIn();
          return;
        }

        mutate(undefined);
      }}
      disabled={!hasTranscript || isPending || !hasServerUrl}
      className="cursor-pointer"
    >
      {isPending ? (
        <Loader2Icon className="animate-spin" />
      ) : (
        <BrainCircuitIcon />
      )}
      <span>
        {isPending
          ? "Uploading..."
          : hasServerUrl
            ? auth.session
              ? "Upload to Digital Brain"
              : "Sign in to upload"
            : "Upload unavailable"}
      </span>
    </DropdownMenuItem>
  );
}
