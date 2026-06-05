import { MicIcon } from "lucide-react";

import { ListenButton } from "./listen";

import {
  useCurrentNoteTab,
  useHasTranscript,
} from "~/session/components/shared";
import { ChatCTA } from "~/shared/chat-cta";
import type { Tab } from "~/store/zustand/tabs/schema";
import { useListener } from "~/stt/contexts";
import { useStartListening } from "~/stt/useStartListening";

export function FloatingActionButton({
  tab,
}: {
  tab: Extract<Tab, { type: "sessions" }>;
}) {
  const shouldShowListen = useShouldShowListeningFab(tab);
  const shouldShowChat = useShouldShowChatFab(tab);
  const shouldShowResume = useShouldShowResumeListeningFab(tab);

  if (!shouldShowListen && !shouldShowChat && !shouldShowResume) {
    return null;
  }

  return (
    <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
      {shouldShowListen ? (
        <ListenButton tab={tab} />
      ) : (
        <div className="flex flex-col items-center gap-2">
          {shouldShowResume && <ResumeListeningButton sessionId={tab.id} />}
          {shouldShowChat && <ChatCTA />}
        </div>
      )}
    </div>
  );
}

export function useShouldShowListeningFab(
  tab: Extract<Tab, { type: "sessions" }>,
) {
  const currentTab = useCurrentNoteTab(tab);
  const hasTranscript = useHasTranscript(tab.id);

  return currentTab.type === "raw" && !hasTranscript;
}

function useShouldShowChatFab(tab: Extract<Tab, { type: "sessions" }>) {
  const hasTranscript = useHasTranscript(tab.id);
  const sessionMode = useListener((state) => state.getSessionMode(tab.id));

  return hasTranscript && sessionMode === "inactive";
}

function useShouldShowResumeListeningFab(
  tab: Extract<Tab, { type: "sessions" }>,
) {
  const hasTranscript = useHasTranscript(tab.id);
  const sessionMode = useListener((state) => state.getSessionMode(tab.id));

  return hasTranscript && sessionMode === "inactive";
}

function ResumeListeningButton({ sessionId }: { sessionId: string }) {
  const startListening = useStartListening(sessionId);
  const canStartLiveSession = useListener((state) =>
    state.canStartLiveSession(sessionId),
  );

  return (
    <button
      type="button"
      onClick={startListening}
      disabled={!canStartLiveSession}
      className="flex items-center gap-2 rounded-full border-2 border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-800 shadow-[0_4px_14px_rgba(0,0,0,0.1)] transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <MicIcon className="size-4 shrink-0" aria-hidden="true" />
      <span>Resume listening</span>
    </button>
  );
}
