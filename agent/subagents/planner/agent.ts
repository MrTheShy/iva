import { defineAgent } from "eve";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  makeCodexModel,
  providerConfig,
  providerName,
  withReasoningStripped,
} from "../../provider.js";

// Stesso provider dell'agente principale (agent/provider.ts). Prima qui c'era
// https://ollama.com/v1 hardcoded: con OLLAMA_BASE_URL puntato altrove (DeepSeek)
// o con provider codex/openrouter/opencode ogni delega al planner falliva con 401.
const compat = createOpenAICompatible({
  name: providerName,
  baseURL: providerConfig.baseURL,
  apiKey: providerConfig.apiKey,
  includeUsage: true, // иначе step.completed приходит без usage — см. agent/agent.ts
});

export default defineAgent({
  description:
    "Разбивает крупную цель пользователя на конкретные выполнимые шаги. " +
    "Делегируй сюда, когда задача большая и её нужно декомпозировать на план.",
  model: withReasoningStripped(
    providerName === "codex"
      ? makeCodexModel()
      : compat(providerConfig.textModel),
  ),
  modelContextWindowTokens: providerConfig.contextWindow,
  // Task-mode: при делегировании возвращает структурированный план.
  outputSchema: z.object({
    goal: z.string(),
    steps: z.array(
      z.object({
        title: z.string(),
        detail: z.string(),
        priority: z.enum(["low", "med", "high"]),
      }),
    ),
  }),
});
