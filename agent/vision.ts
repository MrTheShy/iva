import { streamText } from "ai";
import { providerConfig, providerName, makeCodexModel } from "./provider.js";

const PROMPT =
  "Опиши изображение детально и по делу: что на нём, дословный текст (OCR), важные детали и цифры. " +
  "Без преамбул и воды — только содержимое.";

// Распознаёт картинку vision-моделью ТОГО ЖЕ провайдера (на существующем доступе, без доп-подписок).
// Возвращает текстовое описание, либо "" если распознать нечем (нет ключа/vision-модели).
// Сетевые/HTTP-ошибки бросает — вызывающий ловит и продолжает ход без зрения (graceful).
export async function describeImage(
  bytes: ArrayBuffer,
  mimeType?: string,
): Promise<string> {
  // codex-подписка: Responses API мультимодален — гоним картинку через ту же модель/токен.
  // ВАЖНО: бэкенд подписки принимает ТОЛЬКО stream:true → streamText, не generateText (иначе 400).
  if (providerName === "codex") {
    const result = streamText({
      model: makeCodexModel(providerConfig.visionModel),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            // file-part (не устаревший image-part): AI SDK кодирует его в input_image для Responses.
            {
              type: "file",
              data: new Uint8Array(bytes),
              mediaType: mimeType || "image/jpeg",
            },
          ],
        },
      ],
    });
    let out = "";
    for await (const chunk of result.textStream) out += chunk;
    return out.trim();
  }

  // Endpoint di visione dedicato: il provider di testo può non avere modelli
  // multimodali (es. api.deepseek.com) — VISION_BASE_URL/VISION_API_KEY/
  // VISION_MODEL puntano lo sguardo altrove senza cambiare il resto.
  const baseURL = process.env.VISION_BASE_URL || providerConfig.baseURL;
  const apiKey = process.env.VISION_API_KEY || providerConfig.apiKey;
  const visionModel = process.env.VISION_MODEL || providerConfig.visionModel;
  if (!apiKey || !visionModel) return "";
  const b64 = Buffer.from(bytes).toString("base64");
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // Stesso principio del canale: un provider appeso non blocca il turno.
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: visionModel,
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType || "image/jpeg"};base64,${b64}`,
              },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok)
    throw new Error(
      `vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}
