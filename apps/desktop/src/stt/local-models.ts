import type { LocalModel, SttModelInfo } from "@hypr/plugin-local-stt";

export const RECOMMENDED_LOCAL_BATCH_STT_MODEL =
  "soniqo-qwen3-large" satisfies LocalModel;

export function isRealtimeLocalSttModel(model?: string | null) {
  return model === "soniqo-parakeet-streaming";
}

const SONIQO_MODEL_ORDER: LocalModel[] = [
  RECOMMENDED_LOCAL_BATCH_STT_MODEL,
  "soniqo-qwen3-small",
  "soniqo-omnilingual",
  "soniqo-parakeet-batch",
  "soniqo-parakeet-streaming",
];

function soniqoModelRank(model: LocalModel) {
  const index = SONIQO_MODEL_ORDER.indexOf(model);
  return index === -1 ? SONIQO_MODEL_ORDER.length : index;
}

export function sortSoniqoModelsForRecommendation<T extends SttModelInfo>(
  models: T[],
) {
  return [...models].sort((left, right) => {
    const leftRank = soniqoModelRank(left.key);
    const rightRank = soniqoModelRank(right.key);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.display_name.localeCompare(right.display_name);
  });
}
