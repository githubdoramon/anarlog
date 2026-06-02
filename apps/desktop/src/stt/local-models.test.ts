import { describe, expect, test } from "vitest";

import {
  RECOMMENDED_LOCAL_BATCH_STT_MODEL,
  sortSoniqoModelsForRecommendation,
} from "./local-models";

describe("local model recommendations", () => {
  test("puts Qwen3 Large first among Soniqo models", () => {
    const sorted = sortSoniqoModelsForRecommendation([
      {
        key: "soniqo-parakeet-streaming",
        display_name: "Soniqo Parakeet Streaming",
        description: "",
        size_bytes: 120,
        model_type: "soniqo",
      },
      {
        key: "soniqo-qwen3-large",
        display_name: "Soniqo Qwen3 1.7B",
        description: "",
        size_bytes: 1700,
        model_type: "soniqo",
      },
      {
        key: "soniqo-parakeet-batch",
        display_name: "Soniqo Parakeet Batch",
        description: "",
        size_bytes: 600,
        model_type: "soniqo",
      },
    ]);

    expect(sorted[0]?.key).toBe(RECOMMENDED_LOCAL_BATCH_STT_MODEL);
  });
});
