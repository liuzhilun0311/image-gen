#!/usr/bin/env node

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { requestImageJSON, readLimitedBody } from "./request-controls.mjs";
import { lookupActualCost, buildCostSummary, formatCostSummary } from "./cost-summary.mjs";
import { imageDimensions, imageStructureIsComplete } from "./image-info.mjs";

const DEFAULT_MODEL = "gpt-image-2.5-flare";
const DEFAULT_BASE_URL = "https://code.heihuzi.ai";
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_N = 1;
const DEFAULT_RESOLUTION = "1k";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_MODE = "current";
const DEFAULT_CURRENT_QUALITY = "low";
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MIN_INTERVAL_MS = 0;
const MAX_REFERENCE_IMAGES = 16;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 128 * 1024 * 1024;
const SUPPORTED_MODES = new Set(["current", "official-compatible"]);
const MODEL_GPT_IMAGE_2 = "gpt-image-2";
const MODEL_FLARE = "gpt-image-2.5-flare";
const MODEL_SUNBURST = "gpt-image-2.5-sunburst";
const SUPPORTED_MODELS = new Set([MODEL_GPT_IMAGE_2, MODEL_FLARE, MODEL_SUNBURST]);
const SUPPORTED_QUALITIES = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
const LEGACY_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const SUPPORTED_BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const SUPPORTED_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const SUPPORTED_MODERATION = new Set(["auto", "low"]);
const SUPPORTED_RESOLUTIONS = new Set(["1k", "2k", "4k"]);
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "21:9",
  "9:21",
]);
const OFFICIAL_PRESET_SIZES = new Map([
  ["1k|1:1", "1024x1024"],
  ["1k|3:2", "1536x1024"],
  ["1k|2:3", "1024x1536"],
  ["2k|1:1", "2048x2048"],
  ["2k|16:9", "2048x1152"],
  ["4k|16:9", "3840x2160"],
  ["4k|9:16", "2160x3840"],
]);
const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".avif", "image/avif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);
const SUPPORTED_REFERENCE_IMAGE_MIME_TYPES = new Set(IMAGE_MIME_BY_EXT.values());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOTENV_PATH = path.join(__dirname, ".env");

function nowText() {
  return new Date().toTimeString().slice(0, 8);
}

function timestampText() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "_",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function printHelp() {
  console.log(`用法:
  node gpt-image2.mjs [prompt]
  node gpt-image2.mjs --prompt "提示词"

可选参数:
  -p, --prompt <text>      提示词，优先级高于位置参数
  -m, --model <name>       模型名：gpt-image-2.5-flare（默认，更快）、gpt-image-2.5-sunburst（更精细）、gpt-image-2
  -n <count>               生成张数，默认读取 .env 的 GPT_IMAGE2_N，未设置则 ${DEFAULT_N}
  -i, --image <path>       参考图路径，可重复传入；有参考图时固定输出 1 张
  --reference <path>       --image 的别名
  --reference-image <path> --image 的别名
  --mode <current|official-compatible>
                            内部请求模式，默认读取 .env 的 GPT_IMAGE2_MODE，未设置则 ${DEFAULT_MODE}
  --resolution <1k|2k|4k>  分辨率；未指定时默认读取 .env 的 GPT_IMAGE2_RESOLUTION，未设置则 ${DEFAULT_RESOLUTION.toUpperCase()}
  --aspect-ratio <ratio>   宽高比，例如 1:1、16:9、9:16；未指定时默认读取 .env 的 GPT_IMAGE2_ASPECT_RATIO，未设置则 ${DEFAULT_ASPECT_RATIO}
  --quality <auto|low|medium|high|xhigh|max>
                            默认画图通道未指定时使用 low；xhigh/max 仅 flare/sunburst
  --background <auto|opaque|transparent>
                            透明底仅 flare/sunburst，且需 png 或 webp
  --output-format <png|jpeg|webp>
  --output-compression <0-100>
                            仅 jpeg/webp
  --moderation <auto|low>  审核强度，未指定则不传
  --base-url <url>         接口地址，默认读取 .env 的 GPT_IMAGE2_BASE_URL，未设置则 ${DEFAULT_BASE_URL}
  --api-key <key>          API Key，默认读取 .env 的 GPT_IMAGE2_API_KEY
  --out-dir <path>         输出目录，默认读取 .env 的 GPT_IMAGE2_OUT_DIR，未设置则 ./image2_output
  --timeout-ms <number>    请求超时毫秒数，默认读取 .env 的 GPT_IMAGE2_TIMEOUT_MS，未设置则 ${DEFAULT_TIMEOUT_MS}
  --max-retries <0-10>     仅对 429 限流重试，默认 ${DEFAULT_MAX_RETRIES} 次；不自动重发超时或 5xx 请求
  --min-interval-ms <ms>  相同通道和密钥的本机请求启动间隔，默认 ${DEFAULT_MIN_INTERVAL_MS}（关闭）；不代表账户额度
  --show-cost             图片后附模型、分辨率、质量、输入/输出 token、实际生图费用
  --no-cost               本次不查询或显示费用摘要
  --cost-lookup-cli <path> 只读费用查询工具路径（内部配置）
  --dry-run                只打印将要请求的 URL 和请求形态，不调用接口、不扣费
  -h, --help               显示帮助
`);
}

function loadDotEnv(filePath) {
  if (!fsSync.existsSync(filePath)) {
    return {};
  }

  const content = fsSync.readFileSync(filePath, "utf8");
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const [, key, rawValue] = assignment;
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(rawValue);
    env[key] = quoted ? quoted[2] : rawValue.replace(/\s+#.*$/, "").trim();
  }

  return env;
}

function parsePositiveInt(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = String(value ?? "").trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 的整数`);
  }
  return parsed;
}

function parseNonnegativeInt(value, name, max = Number.MAX_SAFE_INTEGER) {
  const raw = String(value ?? "").trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error(`${name} 必须是 0 到 ${max} 的整数`);
  }
  return parsed;
}

function parseBoolean(value, name) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off", ""].includes(raw)) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function normalizeOptionalResolution(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!SUPPORTED_RESOLUTIONS.has(normalized)) {
    throw new Error(`${name} 只能是 1k、2k 或 4k`);
  }
  return normalized;
}

function normalizeOptionalAspectRatio(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (!SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    throw new Error(`${name} 不支持: ${normalized}`);
  }
  return normalized;
}

function normalizeMode(value, name) {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = raw === "openai" || raw === "official" || raw === "openai-compatible"
    ? "official-compatible"
    : raw;
  if (!normalized) {
    return DEFAULT_MODE;
  }
  if (!SUPPORTED_MODES.has(normalized)) {
    throw new Error(`${name} 只能是 current 或 official-compatible`);
  }
  return normalized;
}

function normalizeOptionalQuality(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!SUPPORTED_QUALITIES.has(normalized)) {
    throw new Error(`${name} 只能是 auto、low、medium、high、xhigh 或 max`);
  }
  return normalized;
}

function isExactGPTImage2(model) {
  return String(model || "").trim().toLowerCase() === MODEL_GPT_IMAGE_2;
}

function normalizeModel(value, name) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return DEFAULT_MODEL;
  }
  if (raw === "flare" || raw === "gpt-image-2.5") {
    return MODEL_FLARE;
  }
  if (raw === "sunburst") {
    return MODEL_SUNBURST;
  }
  if (SUPPORTED_MODELS.has(raw)) {
    return raw;
  }
  throw new Error(`${name} 只能是 gpt-image-2.5-flare、gpt-image-2.5-sunburst 或 gpt-image-2`);
}

function assertQualityForModel(quality, model) {
  if (!quality) {
    return;
  }
  if (isExactGPTImage2(model) && !LEGACY_QUALITIES.has(quality)) {
    throw new Error("旧模型不支持超高/最高画质，请改用更快的 flare、更精细的 sunburst，或把画质降到 high");
  }
}

function normalizeOptionalBackground(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!SUPPORTED_BACKGROUNDS.has(normalized)) {
    throw new Error(`${name} 只能是 auto、opaque 或 transparent`);
  }
  return normalized;
}

function normalizeOptionalOutputFormat(value, name) {
  let normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "jpg") {
    normalized = "jpeg";
  }
  if (!SUPPORTED_OUTPUT_FORMATS.has(normalized)) {
    throw new Error(`${name} 只能是 png、jpeg 或 webp`);
  }
  return normalized;
}

function normalizeOptionalModeration(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!SUPPORTED_MODERATION.has(normalized)) {
    throw new Error(`${name} 只能是 auto 或 low`);
  }
  return normalized;
}

function normalizeOptionalOutputCompression(value, name) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  return parseNonnegativeInt(raw, name, 100);
}

function resolveOutputOptions(options) {
  const model = normalizeModel(options.model, "--model");
  const quality = options.quality;
  const background = options.background;
  let outputFormat = options.outputFormat;
  const outputCompression = options.outputCompression;
  const moderation = options.moderation;

  assertQualityForModel(quality, model);

  if (background === "transparent") {
    if (isExactGPTImage2(model)) {
      throw new Error("旧模型不支持透明底，请改用更快的 flare 或更精细的 sunburst");
    }
    if (!outputFormat) {
      outputFormat = "png";
    }
    if (outputFormat === "jpeg") {
      throw new Error("透明底只能用 png 或 webp，不能用 jpeg");
    }
  }

  if (outputCompression !== "" && outputCompression != null) {
    if (!outputFormat || outputFormat === "png") {
      throw new Error("output_compression 只能用于 jpeg 或 webp");
    }
  }

  return {
    ...options,
    model,
    quality,
    background,
    outputFormat,
    outputCompression,
    moderation,
  };
}

function applyOptionalImageFields(requestBody, options) {
  if (options.quality) {
    requestBody.quality = options.quality;
  }
  if (options.background) {
    requestBody.background = options.background;
  }
  if (options.outputFormat) {
    requestBody.output_format = options.outputFormat;
  }
  if (options.outputCompression !== "" && options.outputCompression != null) {
    requestBody.output_compression = options.outputCompression;
  }
  if (options.moderation) {
    requestBody.moderation = options.moderation;
  }
  return requestBody;
}

function greatestCommonDivisor(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function leastCommonMultiple(a, b) {
  if (a <= 0 || b <= 0) {
    return 0;
  }
  return Math.floor((a / greatestCommonDivisor(a, b)) * b);
}

function resolveOfficialImageSize(resolution, aspectRatio) {
  const normalizedResolution = normalizeOptionalResolution(resolution || DEFAULT_RESOLUTION, "--resolution");
  const normalizedRatio = normalizeOptionalAspectRatio(aspectRatio || DEFAULT_ASPECT_RATIO, "--aspect-ratio");
  const preset = OFFICIAL_PRESET_SIZES.get(`${normalizedResolution}|${normalizedRatio}`);
  if (preset) {
    return preset;
  }

  const parts = normalizedRatio.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part) || part <= 0)) {
    throw new Error(`不支持的宽高比: ${normalizedRatio}`);
  }
  let [rawW, rawH] = parts;
  let ratioValue = rawW / rawH;
  if (ratioValue < 1) {
    ratioValue = 1 / ratioValue;
  }
  if (ratioValue > 3) {
    throw new Error(`不支持的宽高比: ${normalizedRatio}`);
  }

  const targetPixelsByResolution = {
    "1k": 1_048_576,
    "2k": 4_194_304,
    "4k": 8_294_400,
  };
  const reducedDivisor = greatestCommonDivisor(rawW, rawH);
  const ratioW = rawW / reducedDivisor;
  const ratioH = rawH / reducedDivisor;
  const widthStep = 16 / greatestCommonDivisor(ratioW, 16);
  const heightStep = 16 / greatestCommonDivisor(ratioH, 16);
  const unit = leastCommonMultiple(widthStep, heightStep);
  if (unit <= 0) {
    throw new Error(`不支持的宽高比: ${normalizedRatio}`);
  }
  const maxScaleBySide = Math.min(3840 / ratioW, 3840 / ratioH);
  const maxScaleByPixels = Math.sqrt(targetPixelsByResolution[normalizedResolution] / (ratioW * ratioH));
  const maxScale = Math.min(maxScaleBySide, maxScaleByPixels);
  const scale = Math.floor(maxScale / unit) * unit;
  if (scale <= 0) {
    throw new Error(`不支持的宽高比: ${normalizedRatio}`);
  }
  const width = ratioW * scale;
  const height = ratioH * scale;
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) {
    throw new Error(`不支持的分辨率/宽高比组合: ${normalizedResolution} ${normalizedRatio}`);
  }
  return `${width}x${height}`;
}

function resolveOutputDir(outDir) {
  return path.isAbsolute(outDir) ? outDir : path.resolve(process.cwd(), outDir);
}

function resolveInputPath(inputPath) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function parseArgs(argv, dotenvConfig) {
  let promptFlag = null;
  const positionals = [];
  // Resolve overrides before validating, so a CLI correction can repair a bad default.
  const configured = (name, fallback = "") => process.env[name] ?? dotenvConfig[name] ?? fallback;
  const options = {
    model: configured("GPT_IMAGE2_MODEL", DEFAULT_MODEL),
    n: configured("GPT_IMAGE2_N", DEFAULT_N),
    mode: configured("GPT_IMAGE2_MODE", DEFAULT_MODE),
    resolution: configured("GPT_IMAGE2_RESOLUTION", DEFAULT_RESOLUTION),
    aspectRatio: configured("GPT_IMAGE2_ASPECT_RATIO", DEFAULT_ASPECT_RATIO),
    quality: configured("GPT_IMAGE2_QUALITY"),
    background: configured("GPT_IMAGE2_BACKGROUND"),
    outputFormat: configured("GPT_IMAGE2_OUTPUT_FORMAT"),
    outputCompression: configured("GPT_IMAGE2_OUTPUT_COMPRESSION"),
    moderation: configured("GPT_IMAGE2_MODERATION"),
    baseUrl: configured("GPT_IMAGE2_BASE_URL", DEFAULT_BASE_URL),
    apiKey: configured("GPT_IMAGE2_API_KEY"),
    outDir: configured("GPT_IMAGE2_OUT_DIR", "./image2_output"),
    timeoutMs: configured("GPT_IMAGE2_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    maxRetries: configured("GPT_IMAGE2_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    minIntervalMs: configured("GPT_IMAGE2_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS),
    showCost: configured("GPT_IMAGE2_SHOW_COST", false),
    costLookupCLI: configured("GPT_IMAGE2_COST_LOOKUP_CLI"),
    dryRun: false,
    images: [],
  };

  const readValue = (index, arg) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`${arg} 需要一个值`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "-p" || arg === "--prompt") {
      promptFlag = readValue(i, arg);
      i += 1;
      continue;
    }

    if (arg === "-m" || arg === "--model") {
      options.model = normalizeModel(readValue(i, arg), arg);
      i += 1;
      continue;
    }

    if (arg === "--mode") {
      options.mode = normalizeMode(readValue(i, arg), arg);
      i += 1;
      continue;
    }

    if (arg === "-n") {
      options.n = parsePositiveInt(readValue(i, arg), "-n");
      i += 1;
      continue;
    }

    if (arg === "-i" || arg === "--image" || arg === "--reference" || arg === "--reference-image") {
      options.images.push(resolveInputPath(readValue(i, arg)));
      i += 1;
      continue;
    }

    if (arg === "--resolution") {
      options.resolution = normalizeOptionalResolution(readValue(i, arg), "--resolution");
      i += 1;
      continue;
    }

    if (arg === "--aspect-ratio") {
      options.aspectRatio = normalizeOptionalAspectRatio(readValue(i, arg), "--aspect-ratio");
      i += 1;
      continue;
    }

    if (arg === "--quality") {
      options.quality = normalizeOptionalQuality(readValue(i, arg), "--quality");
      i += 1;
      continue;
    }

    if (arg === "--background") {
      options.background = normalizeOptionalBackground(readValue(i, arg), "--background");
      i += 1;
      continue;
    }

    if (arg === "--output-format") {
      options.outputFormat = normalizeOptionalOutputFormat(readValue(i, arg), "--output-format");
      i += 1;
      continue;
    }

    if (arg === "--output-compression") {
      options.outputCompression = normalizeOptionalOutputCompression(
        readValue(i, arg),
        "--output-compression",
      );
      i += 1;
      continue;
    }

    if (arg === "--moderation") {
      options.moderation = normalizeOptionalModeration(readValue(i, arg), "--moderation");
      i += 1;
      continue;
    }

    if (arg === "--base-url") {
      options.baseUrl = readValue(i, arg);
      i += 1;
      continue;
    }

    if (arg === "--api-key") {
      options.apiKey = readValue(i, arg);
      i += 1;
      continue;
    }

    if (arg === "--out-dir") {
      options.outDir = resolveOutputDir(readValue(i, arg));
      i += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(readValue(i, arg), "--timeout-ms");
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--show-cost" || arg === "--no-cost") {
      options.showCost = arg === "--show-cost";
      continue;
    }

    if (arg === "--cost-lookup-cli") {
      options.costLookupCLI = path.resolve(readValue(i, arg));
      i += 1;
      continue;
    }

    if (arg === "--max-retries" || arg === "--min-interval-ms") {
      options[arg === "--max-retries" ? "maxRetries" : "minIntervalMs"] = parseNonnegativeInt(
        readValue(i, arg), arg, arg === "--max-retries" ? 10 : 3_600_000,
      );
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    }

    positionals.push(arg);
  }

  const parsedOptions = {
    ...options,
    prompt: (promptFlag ?? positionals.join(" ")).trim(),
    model: normalizeModel(options.model, "--model / GPT_IMAGE2_MODEL"),
    n: parsePositiveInt(options.n, "-n / GPT_IMAGE2_N"),
    mode: normalizeMode(options.mode, "--mode / GPT_IMAGE2_MODE"),
    resolution: normalizeOptionalResolution(options.resolution, "--resolution / GPT_IMAGE2_RESOLUTION") || DEFAULT_RESOLUTION,
    aspectRatio: normalizeOptionalAspectRatio(options.aspectRatio, "--aspect-ratio / GPT_IMAGE2_ASPECT_RATIO") || DEFAULT_ASPECT_RATIO,
    quality: normalizeOptionalQuality(options.quality, "--quality / GPT_IMAGE2_QUALITY"),
    background: normalizeOptionalBackground(options.background, "--background / GPT_IMAGE2_BACKGROUND"),
    outputFormat: normalizeOptionalOutputFormat(options.outputFormat, "--output-format / GPT_IMAGE2_OUTPUT_FORMAT"),
    outputCompression: normalizeOptionalOutputCompression(options.outputCompression, "--output-compression / GPT_IMAGE2_OUTPUT_COMPRESSION"),
    moderation: normalizeOptionalModeration(options.moderation, "--moderation / GPT_IMAGE2_MODERATION"),
    timeoutMs: parsePositiveInt(options.timeoutMs, "--timeout-ms / GPT_IMAGE2_TIMEOUT_MS", 2_147_483_647),
    maxRetries: parseNonnegativeInt(options.maxRetries, "--max-retries / GPT_IMAGE2_MAX_RETRIES", 10),
    minIntervalMs: parseNonnegativeInt(options.minIntervalMs, "--min-interval-ms / GPT_IMAGE2_MIN_INTERVAL_MS", 3_600_000),
    showCost: parseBoolean(options.showCost, "--show-cost / GPT_IMAGE2_SHOW_COST"),
    apiKey: String(options.apiKey).trim(),
    outDir: resolveOutputDir(String(options.outDir).trim() || "./image2_output"),
    costLookupCLI: String(options.costLookupCLI).trim() ? path.resolve(String(options.costLookupCLI).trim()) : "",
  };
  if (!parsedOptions.prompt) throw new Error("缺少有效提示词，请说明要生成什么图片");
  if (!parsedOptions.aspectRatio) {
    parsedOptions.aspectRatio = DEFAULT_ASPECT_RATIO;
  }
  return resolveOutputOptions(parsedOptions);
}

function inferMimeTypeFromMagic(raw) {
  if (raw.length >= 8 && raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) {
    return "image/jpeg";
  }
  if (raw.length >= 12 && raw.subarray(0, 4).toString("ascii") === "RIFF" && raw.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (raw.length >= 6) {
    const gifHeader = raw.subarray(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return "image/gif";
    }
  }
  if (raw.length >= 2 && raw.subarray(0, 2).toString("ascii") === "BM") {
    return "image/bmp";
  }
  if (raw.length >= 12 && raw.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = raw.subarray(8, 12).toString("ascii").trim();
    if (brand === "avif" || brand === "avis") {
      return "image/avif";
    }
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx" || brand === "mif1" || brand === "msf1") {
      return "image/heic";
    }
  }
  if (
    raw.length >= 4 &&
    ((raw[0] === 0x49 && raw[1] === 0x49 && raw[2] === 0x2a && raw[3] === 0x00) ||
      (raw[0] === 0x4d && raw[1] === 0x4d && raw[2] === 0x00 && raw[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  return "";
}

function inferReferenceImageMimeType(raw) {
  return inferMimeTypeFromMagic(raw);
}

async function loadReferenceImages(imagePaths) {
  if (imagePaths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`参考图最多支持 ${MAX_REFERENCE_IMAGES} 张`);
  }

  const images = [];
  for (const imagePath of imagePaths) {
    const stat = await fs.stat(imagePath).catch((error) => {
      throw new Error(`参考图不存在或无法读取: ${imagePath} (${error.message})`);
    });
    if (!stat.isFile()) {
      throw new Error(`参考图不是文件: ${imagePath}`);
    }
    if (stat.size <= 0) {
      throw new Error(`参考图为空文件: ${imagePath}`);
    }
    if (stat.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`参考图超过 10MB 限制: ${imagePath}`);
    }

    const raw = await fs.readFile(imagePath);
    if (raw.length > MAX_REFERENCE_IMAGE_BYTES) throw new Error(`参考图超过 10MB 限制: ${imagePath}`);
    const mimeType = inferReferenceImageMimeType(raw);
    if (!SUPPORTED_REFERENCE_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new Error(`参考图格式不支持或无法识别: ${imagePath}`);
    }
    if (["image/png", "image/jpeg", "image/webp"].includes(mimeType)) validateImageBytes(raw);

    images.push({
      path: imagePath,
      filename: path.basename(imagePath),
      mimeType,
      raw,
      sizeBytes: raw.length,
    });
  }
  return images;
}

function decodeImageField(value) {
  if (typeof value !== "string") throw new Error("图片 Base64 字段必须是字符串");
  let payload = value.trim();

  if (payload.startsWith("data:")) {
    const splitIndex = payload.indexOf(",");
    if (splitIndex === -1) {
      throw new Error("data URL 缺少逗号分隔符");
    }
    const header = payload.slice(5, splitIndex);
    if (!/^image\/[^;,]+;base64$/i.test(header)) throw new Error("图片 data URL 必须使用 Base64 编码");
    payload = payload.slice(splitIndex + 1);
  }

  payload = payload.replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    throw new Error("图片 Base64 为空或编码无效");
  }
  const missingPadding = (4 - (payload.length % 4)) % 4;
  if (missingPadding > 0) {
    payload += "=".repeat(missingPadding);
  }

  const raw = Buffer.from(payload, "base64");
  if (raw.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) {
    throw new Error("图片 Base64 编码无效");
  }
  return validateImageBytes(raw);
}

function validateImageBytes(raw) {
  if (raw.length > MAX_OUTPUT_IMAGE_BYTES) throw new Error("图片大小超过 128MB 限制");
  const mimeType = inferMimeTypeFromMagic(raw);
  if (!raw.length || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    throw new Error("返回内容不是可识别的 PNG/JPEG/WebP 图片");
  }
  const dimensions = imageDimensions(raw, mimeType);
  if (!dimensions || !imageStructureIsComplete(raw, mimeType)) {
    throw new Error("图片文件损坏、不完整或无法读取有效尺寸");
  }
  return { raw, mimeType, ...dimensions };
}

function suffixFromMime(mimeType) {
  return { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[mimeType];
}

function joinUrl(baseUrl, suffix) {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

function validateBaseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error("接口地址必须是完整的 http/https URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || /\/register\/?$/i.test(url.pathname)) {
    throw new Error("请填写 API 基础地址，不要填写注册链接、查询参数或含账号密码的 URL");
  }
  return url.href.replace(/\/+$/, "");
}

function hasConfiguredKey(key) {
  return !!key && !/^(?:your[_ -]?(?:api[_ -]?)?key|sk-(?:x+|your.*)|你的API密钥|你的密钥|在这里填写.*)$/i.test(key);
}

async function prepareOutputDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.gpt-image-write-check-${randomUUID()}`);
  const handle = await fs.open(probe, "wx", 0o600);
  try { await handle.writeFile("write check"); } finally {
    await handle.close();
    await fs.unlink(probe);
  }
}

function displayResult(record, metadataPath, costSummary) {
  console.log(`result = ${JSON.stringify({
    status: record.status, images: record.images, metadata_path: metadataPath,
    errors: record.errors, warnings: record.warnings,
    ...(costSummary ? { cost_summary: costSummary } : {}),
  })}`);
  for (const [index, image] of record.images.entries()) {
    const destination = image.path.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\n/g, "%0A").replace(/\r/g, "%0D");
    console.log(`![生成图片 ${index + 1}](<${destination}>)`);
  }
  if (costSummary) console.log(formatCostSummary(costSummary));
}

function redactValue(value, apiKey) {
  if (!apiKey) return value;
  if (typeof value === "string") return value.replaceAll(apiKey, "[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactValue(item, apiKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, apiKey)]));
  }
  return value;
}

async function updateRecord(metadataPath, record) {
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, metadataPath);
  } finally { await fs.unlink(temporaryPath).catch(() => {}); }
}

async function requestJson(url, body, options) {
  return requestImageJSON(url, () => JSON.stringify(body), "application/json", options);
}

async function requestMultipart(url, fields, images, options) {
  return requestImageJSON(url, () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
    }
    for (const image of images) {
      form.append("image", new Blob([image.raw], { type: image.mimeType }), image.filename);
    }
    return form;
  }, null, options);
}

async function downloadImageURL(url, timeoutMs) {
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("图片下载地址必须是无账号密码的 http/https URL");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = (await readLimitedBody(response, 1024 * 1024)).toString("utf8");
      throw new Error(`download HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim();
    if (contentType && contentType !== "application/octet-stream" && !contentType.startsWith("image/")) {
      throw new Error(`download returned non-image content-type: ${contentType}`);
    }

    return validateImageBytes(await readLimitedBody(response, MAX_OUTPUT_IMAGE_BYTES));
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { printHelp(); return; }
  if (typeof fetch !== "function" || typeof FormData !== "function" || typeof Blob !== "function") {
    throw new Error("运行此技能需要带 fetch/FormData/Blob 的 Node.js，请使用 Node.js 20 或更新版本");
  }
  const dotenvConfig = loadDotEnv(DOTENV_PATH);
  const options = parseArgs(argv, dotenvConfig);
  options.baseUrl = validateBaseUrl(options.baseUrl);
  if (!options.dryRun && !hasConfiguredKey(options.apiKey)) {
    throw new Error(`尚未配置 API Key。请参考 ${path.resolve(__dirname, "../README.md")}，在 ${DOTENV_PATH} 填写 GPT_IMAGE2_API_KEY；无需把密钥发到对话中`);
  }

  console.log(`[${nowText()}] prompt: ${redactValue(options.prompt, options.apiKey)}`);
  const imageSize = resolveOfficialImageSize(options.resolution, options.aspectRatio);
  const hasReferenceImages = options.images.length > 0;
  const referenceImages = hasReferenceImages ? await loadReferenceImages(options.images) : [];
  const quality = options.quality || (options.mode === "current" ? DEFAULT_CURRENT_QUALITY : "");
  assertQualityForModel(quality, options.model);
  const requestOptions = { ...options, quality };

  const extra = [
    `model=${options.model}`,
    `resolution=${options.resolution}`,
    `aspect_ratio=${options.aspectRatio}`,
    `size=${imageSize}`,
  ];
  if (quality) extra.push(`quality=${quality}`);
  if (options.background) extra.push(`background=${options.background}`);
  if (options.outputFormat) extra.push(`output_format=${options.outputFormat}`);
  if (options.outputCompression !== "" && options.outputCompression != null) {
    extra.push(`output_compression=${options.outputCompression}`);
  }
  if (options.moderation) extra.push(`moderation=${options.moderation}`);
  extra.push(hasReferenceImages
    ? `reference_images=${referenceImages.length}, output=1`
    : `output=${options.n}`);
  console.log(`[${nowText()}] options: ${extra.join(", ")}`);

  const requestUrl = joinUrl(options.baseUrl, hasReferenceImages ? "/images/edits" : "/images/generations");
  const requestBody = applyOptionalImageFields({
    model: options.model, prompt: options.prompt, size: imageSize,
    ...(!hasReferenceImages ? { n: options.n } : {}),
  }, requestOptions);
  let resp = null;
  let elapsedSeconds = 0;

  if (options.dryRun) {
    console.log(`[${nowText()}] dry-run url: ${requestUrl}`);
      console.log(JSON.stringify(redactValue(hasReferenceImages ? {
        fields: requestBody,
        reference_images: referenceImages.map((image) => ({
          path: image.path,
          filename: image.filename,
          mime_type: image.mimeType,
          size_bytes: image.sizeBytes,
        })),
        output_count: 1,
      } : requestBody, options.apiKey), null, 2));
    return;
  }

  await prepareOutputDirectory(options.outDir);
  const runId = `${timestampText()}_${randomUUID()}`;
  const metadataPath = path.join(options.outDir, `gpt-image2_${runId}.json`);
  const record = redactValue({
    run_id: runId,
    saved_at: new Date().toISOString(),
    status: "pending",
    request: requestBody,
    reference_images: referenceImages.map(({ path, mimeType, sizeBytes }) => ({ path, mime_type: mimeType, bytes: sizeBytes })),
    images: [],
    errors: [],
    warnings: [],
    recoverable_images: [],
  }, options.apiKey);
  if (hasReferenceImages && options.n !== 1) {
    record.warnings.push(`参考图请求每次只输出 1 张；本次没有向服务提交 ${options.n} 张的要求`);
  }
  // Persist intent before sending a potentially billable request.
  await fs.writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const start = Date.now();
  try {
    const result = hasReferenceImages
      ? await requestMultipart(requestUrl, requestBody, referenceImages, options)
      : await requestJson(requestUrl, requestBody, options);
    resp = result.body;
    Object.assign(record, redactValue(result.metadata, options.apiKey));
  } catch (error) {
    record.status = "failed";
    record.errors.push(error.message.replaceAll(options.apiKey, "[redacted]"));
    record.elapsed_seconds = (Date.now() - start) / 1000;
    Object.assign(record, redactValue(error.metadata ?? {}, options.apiKey));
    let metadataSaved = true;
    try { await updateRecord(metadataPath, record); }
    catch {
      metadataSaved = false;
      record.warnings.push("未能更新本地生成记录，请根据运行记录核对服务端状态");
    }
    displayResult(record, metadataSaved ? metadataPath : null);
    throw new Error(record.errors.join("；"));
  }
  elapsedSeconds = (Date.now() - start) / 1000;
  Object.assign(record, redactValue({
    response_created: resp.created ?? null, response_model: resp.model ?? null,
    usage: resp.usage ?? null, elapsed_seconds: elapsedSeconds,
  }, options.apiKey));
  console.log(`[${nowText()}] 耗时 ${elapsedSeconds.toFixed(1)}s`);
  console.log(`resp.created = ${record.response_created}`);
  console.log(`resp.usage = ${JSON.stringify(record.usage)}`);
  const responseData = Array.isArray(resp.data) ? resp.data : [];
  const data = responseData;
  if (!data.length) record.errors.push("接口返回了空图片结果，没有可保存的图片");

  const outcomes = new Array(data.length);
  let nextImage = 0;
  const downloadDeadline = Date.now() + options.timeoutMs;
  const saveImage = async (index, img) => {
    try {
      let image;
      let source;
      if (img?.b64_json != null && img.b64_json !== "") {
        image = decodeImageField(img.b64_json);
        source = "base64";
      } else if (typeof img?.url === "string" && img.url.trim()) {
        const remaining = downloadDeadline - Date.now();
        if (remaining <= 0) throw new Error("图片下载超时；不会自动重新生图");
        image = await downloadImageURL(img.url, remaining);
        source = "url";
      } else {
        throw new Error("没有可用图片字段（b64_json 或 url）");
      }
      const { raw, mimeType, width, height } = image;
      const filename = path.join(
        options.outDir,
        `gpt-image2_${runId}_${index + 1}${suffixFromMime(mimeType)}`,
      );
      await fs.writeFile(filename, raw, { flag: "wx" });
      const savedImage = redactValue({
        path: filename, mime_type: mimeType, bytes: raw.length, source,
        width: width ?? null, height: height ?? null,
        model: img.model ?? resp.model ?? options.model,
        revised_prompt: img.revised_prompt ?? null,
      }, options.apiKey);
      const [requestedWidth, requestedHeight] = imageSize.split("x").map(Number);
      if (width !== requestedWidth || height !== requestedHeight) {
        savedImage.warning = `请求尺寸 ${imageSize}，实际返回 ${width}x${height}，请检查比例与清晰度`;
      }
      console.log(`  [${index}] saved ${filename} (${raw.length.toLocaleString()} bytes, ${mimeType})`);
      return { image: savedImage };
    } catch (error) {
      return {
        error: `图片 ${index + 1}：${error.message.replaceAll(options.apiKey, "[redacted]")}`,
        recovery: typeof img?.url === "string" ? {
          index: index + 1, url: redactValue(img.url, options.apiKey),
        } : null,
      };
    }
  };
  // Bound download concurrency while keeping the service's image ordering.
  await Promise.all(Array.from({ length: Math.min(3, data.length) }, async () => {
    while (nextImage < data.length) {
      const index = nextImage++;
      outcomes[index] = await saveImage(index, data[index]);
    }
  }));
  for (const outcome of outcomes) {
    if (outcome.image) {
      record.images.push(outcome.image);
      if (outcome.image.warning) record.warnings.push(outcome.image.warning);
      if (outcome.image.model !== options.model) {
        record.warnings.push(`请求模型 ${options.model}，服务报告模型 ${outcome.image.model}`);
      }
      if (options.outputFormat && suffixFromMime(outcome.image.mime_type) !==
          { png: ".png", jpeg: ".jpg", webp: ".webp" }[options.outputFormat]) {
        record.warnings.push(`请求格式 ${options.outputFormat}，实际返回 ${outcome.image.mime_type}，已按真实格式保存`);
      }
    }
    else {
      record.errors.push(outcome.error);
      if (outcome.recovery) record.recoverable_images.push(outcome.recovery);
    }
  }

  const expectedCount = hasReferenceImages ? 1 : options.n;
  if (record.images.length < expectedCount && !record.errors.length) {
    record.errors.push(`请求 ${expectedCount} 张，实际只保存了 ${record.images.length} 张`);
  }
  if (record.images.length > expectedCount) {
    record.warnings.push(`请求 ${expectedCount} 张，服务返回并保存了 ${record.images.length} 张，请核对服务端计费`);
  }
  record.timing = {
    request_seconds: elapsedSeconds,
    download_and_save_seconds: (Date.now() - start) / 1000 - elapsedSeconds,
    total_seconds: (Date.now() - start) / 1000,
  };
  record.status = record.errors.length ? (record.images.length ? "partial" : "failed") : "success";
  let metadataSaved = true;
  try { await updateRecord(metadataPath, record); }
  catch {
    metadataSaved = false;
    record.warnings.push("图片已处理，但未能更新本地生成记录；请保留已保存图片，不要自动重新生图");
    console.log(record.warnings.at(-1));
  }
  let costSummary;
  if (options.showCost) {
    record.cost = await lookupActualCost(record, options);
    costSummary = buildCostSummary(record);
    try {
      if (!metadataSaved) throw new Error("生成记录不可写");
      await updateRecord(metadataPath, record);
    } catch {
      record.warnings.push("费用摘要已查询，但未能写入本地生成记录");
      console.log("费用摘要已查询，但未能写入本地生成记录");
    }
  }
  displayResult(record, metadataSaved ? metadataPath : null, costSummary);
  if (record.errors.length) throw new Error(record.errors.join("；"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
