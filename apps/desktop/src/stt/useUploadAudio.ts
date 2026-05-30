import { useCallback, useRef, useState } from "react";

export function useUploadAudio() {
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const upload = useCallback(async (_filePath: string): Promise<string> => {
    throw new Error("Cloud audio upload is disabled in this build");
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.();
    setProgress(null);
  }, []);

  return { upload, abort, progress };
}
