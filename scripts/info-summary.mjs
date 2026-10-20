function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function actualAspectRatio(image) {
  if (!Number.isSafeInteger(image.width) || image.width <= 0 ||
      !Number.isSafeInteger(image.height) || image.height <= 0) return null;
  let a = image.width, b = image.height;
  while (b) [a, b] = [b, a % b];
  return `${image.width / a}:${image.height / a}`;
}

export function buildInfoSummary(record) {
  const responseModels = [...new Set((record.images ?? []).map((image) => image.model).filter(Boolean))];
  const dimensions = (record.images ?? []).map((image) =>
    Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0
      ? `${image.width} × ${image.height}` : null);
  const actualResolution = dimensions.length && dimensions.every(Boolean)
    ? [...new Set(dimensions)].join("、") : null;
  const requestedRatio = record.requested_aspect_ratio ?? record.request?.aspect_ratio;
  const actualRatios = (record.images ?? []).map(actualAspectRatio);
  const actualRatio = actualRatios.length && actualRatios.every(Boolean)
    ? [...new Set(actualRatios)].join("、") : null;
  const requestedCount = validCount(record.requested_count) ?? validCount(record.request?.n)
    ?? (record.reference_images?.length ? 1
      : record.provider === "banana" ? validCount(record.subrequests?.length) : null);
  const formats = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP" };
  const outputFormats = [...new Set((record.images ?? []).map((image) => formats[image.mime_type] ?? "未知"))];
  const elapsed = record.timing?.total_seconds ?? record.elapsed_seconds;
  return {
    model: responseModels.length ? responseModels.join("、") : record.response_model ?? record.request?.model ?? "未知",
    resolution: actualResolution ?? (record.request?.size ? `${record.request.size.replace(/x/g, " × ")}（请求尺寸）`
      : record.request?.resolution ? `${record.request.resolution.toUpperCase()} ${record.request.aspect_ratio}（请求规格）` : "未提供"),
    aspect_ratio: requestedRatio ?? actualRatio,
    aspect_ratio_source: requestedRatio ? "requested" : actualRatio ? "actual" : null,
    image_count: (record.images ?? []).length,
    requested_count: requestedCount,
    output_format: outputFormats.length ? outputFormats.join("、") : null,
    background: record.request?.background || null,
    elapsed_seconds: typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
    quality: record.provider === "banana"
      ? (record.request?.thinking === "minimal" ? "minimal_thinking" : "default_thinking")
      : record.request?.quality || "default",
    input_tokens: validCount(record.usage?.input_tokens),
    output_tokens: validCount(record.usage?.output_tokens),
  };
}

export function formatInfoSummary(summary) {
  const names = {
    "gpt-image-2.5-flare": "GPT Image 2.5 Flare",
    "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
    "gemini-nano-banana-2.1": "Nano Banana 2.1",
  };
  const qualities = {
    auto: "自动（auto）", low: "低（low）", medium: "中（medium）", high: "高（high）",
    xhigh: "超高（xhigh）", max: "最高（max）", default: "默认",
    minimal_thinking: "最低思考档（minimal）", default_thinking: "默认思考档",
  };
  const backgrounds = { transparent: "透明", opaque: "不透明", auto: "自动" };
  return [
    `模型：${names[summary.model] ?? summary.model}`,
    `分辨率：${summary.resolution}`,
    `比例：${summary.aspect_ratio ?? "未提供"}${summary.aspect_ratio_source === "requested" ? "（请求比例）"
      : summary.aspect_ratio_source === "actual" ? "（实际比例）" : ""}`,
    `图片数量：${summary.requested_count !== null && summary.image_count !== summary.requested_count
      ? `已保存 ${summary.image_count} 张 / 请求 ${summary.requested_count} 张` : `${summary.image_count} 张`}`,
    `质量：${qualities[summary.quality] ?? summary.quality}`,
    `输出格式：${summary.output_format ?? "未提供"}`,
    `背景：${summary.background ? `${backgrounds[summary.background] ?? summary.background}（请求设置）` : "未指定"}`,
    `总耗时：${summary.elapsed_seconds === null ? "未提供" : `${summary.elapsed_seconds.toFixed(2)} 秒（含保存）`}`,
    `输入/输出 token：${summary.input_tokens ?? "未提供"} / ${summary.output_tokens ?? "未提供"}`,
  ].join("\n");
}
