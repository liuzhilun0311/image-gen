export const MAX_BANANA_REQUEST_BYTES = 95_000_000;
const CHUNK_BYTES = 3 * 16 * 1024;

export function encodeBananaRequest(options, images) {
  const config = {
    responseModalities: ["IMAGE"],
    imageConfig: { imageSize: options.resolution.toUpperCase(), aspectRatio: options.aspectRatio },
    ...(options.quality === "low" ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}),
  };
  const segments = [
    '{"contents":[{"role":"user","parts":[',
    JSON.stringify({ text: options.prompt }),
  ];
  for (const image of images) {
    segments.push(`,{"inlineData":{"mimeType":${JSON.stringify(image.mimeType)},"data":"`,
      image.raw, '"}}');
  }
  segments.push(`]}],"generationConfig":${JSON.stringify(config)}}`);
  const bytes = segments.reduce((total, segment) => total + (Buffer.isBuffer(segment)
    ? 4 * Math.ceil(segment.length / 3) : Buffer.byteLength(segment)), 0);
  if (bytes > MAX_BANANA_REQUEST_BYTES) {
    throw new Error("Banana 请求编码后超过 95MB，请压缩或减少参考图；未发送请求");
  }
  // Base64 chunks must end on a three-byte boundary except for the last chunk.
  const output = Buffer.allocUnsafe(bytes);
  let offset = 0;
  for (const segment of segments) {
    if (!Buffer.isBuffer(segment)) offset += output.write(segment, offset, "utf8");
    else for (let start = 0; start < segment.length; start += CHUNK_BYTES) {
      offset += output.write(segment.subarray(start, start + CHUNK_BYTES).toString("base64"), offset, "ascii");
    }
  }
  return output;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseBananaResponse(body) {
  const data = [];
  const reasons = [];
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  for (const candidate of candidates) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      const inline = part?.inlineData ?? part?.inline_data;
      if (part?.thought !== true && typeof inline?.data === "string" && inline.data.trim()) {
        data.push({ b64_json: inline.data, model: body.modelVersion ?? null });
      }
    }
    if (candidate?.finishReason) reasons.push(String(candidate.finishReason));
  }
  if (body.promptFeedback?.blockReason) reasons.push(String(body.promptFeedback.blockReason));
  const meta = body.usageMetadata ?? {};
  const candidatesTokens = tokenCount(meta.candidatesTokenCount);
  const thoughtsTokens = meta.thoughtsTokenCount === undefined ? 0 : tokenCount(meta.thoughtsTokenCount);
  return {
    data,
    usage: {
      input_tokens: tokenCount(meta.promptTokenCount),
      output_tokens: candidatesTokens !== null && thoughtsTokens !== null ? candidatesTokens + thoughtsTokens : null,
    },
    model: body.modelVersion ?? null, created: null,
    error: data.length ? null : `Banana 未返回图片${reasons.length ? `（${reasons.join("、")}）` : ""}；请核对使用记录，未自动重新生图`,
  };
}

export function createBananaRequest(options, images) {
  const body = encodeBananaRequest(options, images);
  return {
    url: `${options.baseUrl}/v1beta/models/${options.model}:generateContent`,
    summary: {
      model: options.model, prompt: options.prompt, quality: options.quality,
      resolution: options.resolution, aspect_ratio: options.aspectRatio,
      thinking: options.quality === "low" ? "minimal" : "default",
    },
    count: images.length ? 1 : options.n, contentType: "application/json",
    makeBody: () => body, parse: parseBananaResponse,
  };
}
