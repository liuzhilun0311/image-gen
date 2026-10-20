export const GPT_RATIOS = [
  "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
  "16:9", "9:16", "2:1", "1:2", "21:9", "9:21",
];
export const BANANA_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4",
  "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
];
const qualities = ["auto", "low", "medium", "high", "xhigh", "max"];
const gpt = {
  provider: "gpt", transparent: true, maxReferences: 16,
  outputsPerReferenceRun: 1, supportsMultipleOutputs: true,
  ratios: GPT_RATIOS, qualities, resolutions: ["1k", "2k", "4k"],
  outputFormats: ["png", "jpeg", "webp"], maxCount: 4,
  keyVariable: "FLARE_SUNBURST_API_KEY", qualitySemantics: "image quality",
};
export const MODELS = {
  flare: { ...gpt, id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", aliases: ["gpt-image-2.5"] },
  sunburst: { ...gpt, id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", aliases: [] },
  banana: {
    id: "gemini-nano-banana-2.1", name: "Nano Banana 2.1",
    aliases: ["nano-banana-2.1", "nano-banana", "香蕉"],
    provider: "banana", transparent: false, maxReferences: 14,
    outputsPerReferenceRun: 1, supportsMultipleOutputs: false,
    ratios: BANANA_RATIOS, qualities, resolutions: ["1k", "2k", "4k"],
    outputFormats: ["png"], maxCount: 4, keyVariable: "BANANA_API_KEY",
    qualitySemantics: "low: minimal thinking; all other values: default thinking",
  },
};

export function modelCapabilities(value = "flare") {
  const raw = String(value).trim().toLowerCase() || "flare";
  for (const [alias, model] of Object.entries(MODELS)) {
    if ([alias, model.id, ...model.aliases].includes(raw)) return model;
  }
  throw new Error("模型只能是 gpt-image-2.5-flare、gpt-image-2.5-sunburst 或 gemini-nano-banana-2.1");
}

export function validateModelOptions(options) {
  const model = modelCapabilities(options.model);
  if (!model.ratios.includes(options.aspectRatio)) {
    throw new Error(`${model.name} 不支持比例 ${options.aspectRatio}；可选：${model.ratios.join("、")}`);
  }
  if (options.images.length > model.maxReferences) {
    throw new Error(`${model.name} 最多支持 ${model.maxReferences} 张参考图`);
  }
  if (!model.transparent && options.background === "transparent") {
    throw new Error(`${model.name} 不支持透明底，请使用 Flare 或 Sunburst`);
  }
  if (model.provider === "banana") {
    if (options.outputFormat && !model.outputFormats.includes(options.outputFormat)) {
      throw new Error("Banana 不支持指定 JPEG/WebP 编码；请清空 output_format 或使用 png");
    }
    if (options.outputCompression !== "" || options.moderation) {
      throw new Error("Banana 不支持 output_compression 或 moderation 参数，请清空这些 GPT 专属参数");
    }
  }
  return model;
}
