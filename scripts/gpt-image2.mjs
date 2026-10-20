#!/usr/bin/env node

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { requestImageJSON, readLimitedBody } from "./request-controls.mjs";
import { buildInfoSummary, formatInfoSummary } from "./info-summary.mjs";
import { imageDimensions, imageStructureIsComplete } from "./image-info.mjs";
import { MODELS, GPT_RATIOS, BANANA_RATIOS, modelCapabilities, validateModelOptions } from "./model-capabilities.mjs";
import { createGPTRequest } from "./gpt-image.mjs";
import { createBananaRequest } from "./banana-image.mjs";

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
const EXECUTION_CONFIG_KEYS = new Set([
  "schema_version", "request_defaults", "prompt_settings", "prompt_supplements",
  "references", "scheduling", "storage", "limits",
]);
const FORBIDDEN_EXECUTION_CONFIG_KEY =
  /api[_-]?key|authorization|access[_-]?token|secret|base[_-]?url|endpoint|timeout|retries|rate[_-]?limit/i;
const MAX_REFERENCE_IMAGES = 16;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_IMAGES = 4;
const SUPPORTED_MODES = new Set(["current"]);
const SUPPORTED_QUALITIES = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
const SUPPORTED_BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const SUPPORTED_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const SUPPORTED_MODERATION = new Set(["auto", "low"]);
const SUPPORTED_RESOLUTIONS = new Set(["1k", "2k", "4k"]);
const SUPPORTED_ASPECT_RATIOS = new Set([...GPT_RATIOS, ...BANANA_RATIOS]);
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
]);
const SUPPORTED_REFERENCE_IMAGE_MIME_TYPES = new Set(IMAGE_MIME_BY_EXT.values());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOTENV_PATH = path.resolve(__dirname, "../config/.env");
const LEGACY_DOTENV_PATH = path.join(__dirname, ".env");
const PREFERENCES_PATH = path.resolve(__dirname, "../config/extend.md");
const DOTENV_EXAMPLE_PATH = path.resolve(__dirname, "../config/.env.example");
const PREFERENCES_EXAMPLE_PATH = path.resolve(__dirname, "../config/extend.example.md");
const DRAWING_KEYS = {
  model: "GPT_IMAGE2_MODEL", n: "GPT_IMAGE2_N", resolution: "GPT_IMAGE2_RESOLUTION",
  aspect_ratio: "GPT_IMAGE2_ASPECT_RATIO", quality: "GPT_IMAGE2_QUALITY",
  background: "GPT_IMAGE2_BACKGROUND", output_format: "GPT_IMAGE2_OUTPUT_FORMAT",
  output_compression: "GPT_IMAGE2_OUTPUT_COMPRESSION", moderation: "GPT_IMAGE2_MODERATION",
  out_dir: "GPT_IMAGE2_OUT_DIR", show_info: "GPT_IMAGE2_SHOW_INFO",
};
const ENV_ALIASES = {
  IMAGE_GEN_BASE_URL: ["GPT_IMAGE2_BASE_URL"],
  IMAGE_GEN_MODE: ["GPT_IMAGE2_MODE"],
  IMAGE_GEN_TIMEOUT_MS: ["GPT_IMAGE2_TIMEOUT_MS"],
  IMAGE_GEN_MAX_RETRIES: ["GPT_IMAGE2_MAX_RETRIES"],
  IMAGE_GEN_MIN_INTERVAL_MS: ["GPT_IMAGE2_MIN_INTERVAL_MS"],
  IMAGE_GEN_CONCURRENCY: ["GPT_IMAGE2_CONCURRENCY"],
  IMAGE_GEN_PRIVATE_METADATA: ["GPT_IMAGE2_PRIVATE_METADATA"],
  FLARE_SUNBURST_API_KEY: ["GPT_IMAGE2_API_KEY"],
};
const privateValues = new Set();

function configuredEnvironmentValue(dotenvConfig, name) {
  for (const key of [name, ...(ENV_ALIASES[name] ?? [])]) {
    if (Object.hasOwn(process.env, key)) return process.env[key];
    if (Object.hasOwn(dotenvConfig, key)) return dotenvConfig[key];
  }
  return undefined;
}

function hasForbiddenExecutionKey(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    FORBIDDEN_EXECUTION_CONFIG_KEY.test(key) || hasForbiddenExecutionKey(item));
}

function redactText(value) {
  let text = String(value);
  for (const secret of privateValues) text = text.split(secret).join("[redacted]");
  return text;
}

function redactRecord(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /api[_-]?key|authorization|access[_-]?token|secret/i.test(key) ? "[redacted]" : redactRecord(item),
    ]));
  }
  return value;
}

for (const method of ["log", "error", "warn"]) {
  const original = console[method].bind(console);
  console[method] = (...values) => original(...values.map((value) =>
    typeof value === "string" ? redactText(value) : redactRecord(value)));
}

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
  node gpt-image2.mjs models

可选参数:
  -p, --prompt <text>      提示词，优先级高于位置参数
  -m, --model <name>       模型别名：flare（默认）、sunburst、banana；也支持完整模型 ID
  -n <count>               生成张数 1–4，默认读取 config/extend.md 的 n，未设置则 ${DEFAULT_N}
  -i, --image <path>       参考图路径，可重复传入；有参考图时固定输出 1 张
  --reference <path>       --image 的别名
  --reference-image <path> --image 的别名
  --mode <current>         请求模式，当前仅支持 current
  --resolution <1k|2k|4k>  分辨率；默认读取 config/extend.md 的 resolution，未设置则 ${DEFAULT_RESOLUTION.toUpperCase()}
  --aspect-ratio <ratio>   宽高比，例如 1:1、16:9、9:16；默认读取 config/extend.md 的 aspect_ratio，未设置则 ${DEFAULT_ASPECT_RATIO}
  --quality <auto|low|medium|high|xhigh|max>
                            默认 low；Banana 的 low 为最低思考档，其他值使用默认思考档
  --background <auto|opaque|transparent>
                            透明底仅 flare/sunburst，且需 png 或 webp
  --output-format <png|jpeg|webp>
  --output-compression <0-100>
                            仅 jpeg/webp
  --moderation <auto|low>  审核强度，未指定则不传
  --base-url <url>         仅本机测试使用；正式请求固定使用 .env 的服务平台地址
  --out-dir <path>         输出目录，默认读取 config/extend.md 的 out_dir，未设置则 ./image_output
  --timeout-ms <number>    请求超时毫秒数，默认读取 .env 的 IMAGE_GEN_TIMEOUT_MS，未设置则 ${DEFAULT_TIMEOUT_MS}
  --max-retries <0-10>     仅对 429 限流重试，默认 ${DEFAULT_MAX_RETRIES} 次；不自动重发超时或 5xx 请求
  --min-interval-ms <ms>  相同通道和密钥的本机请求启动间隔，默认 ${DEFAULT_MIN_INTERVAL_MS}（关闭）；不代表账户额度
  --concurrency <1-4>     Banana 多图并发上限，默认 2；所有请求共用生成超时
  --show-info             图片后附模型、分辨率、比例、张数、质量、格式、背景、耗时、token
  --no-info               本次不显示图片信息摘要
  --dry-run                只打印将要请求的 URL 和请求形态，不调用接口、不扣费
  --execution-config <path> 使用调用任务的非敏感参数快照，覆盖作图默认值
  --check-config           仅检查本机配置并输出非敏感默认值，不发送请求
  --private-metadata       生成记录只保存文件名，避免写入完整本机路径
  -h, --help               显示帮助

服务运行配置：config/.env；不存在时兼容 scripts/.env。
作图偏好：config/extend.md；同名环境变量及旧 .env 作图项优先于偏好。
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

function ensureConfigFiles() {
  const configDir = path.dirname(DOTENV_PATH);
  fsSync.mkdirSync(configDir, { recursive: true });
  if (!fsSync.existsSync(DOTENV_PATH) &&
      !fsSync.existsSync(LEGACY_DOTENV_PATH) &&
      fsSync.existsSync(DOTENV_EXAMPLE_PATH)) {
    fsSync.copyFileSync(DOTENV_EXAMPLE_PATH, DOTENV_PATH);
  }
  if (!fsSync.existsSync(PREFERENCES_PATH) &&
      fsSync.existsSync(PREFERENCES_EXAMPLE_PATH)) {
    fsSync.copyFileSync(PREFERENCES_EXAMPLE_PATH, PREFERENCES_PATH);
  }
}

function loadPreferenceDefaults(filePath) {
  if (!fsSync.existsSync(filePath)) return {};
  const text = fsSync.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const blocks = [...text.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)];
  if (blocks.length !== 1) throw new Error("config/extend.md must contain exactly one JSON block");
  let data;
  try { data = JSON.parse(blocks[0][1]); }
  catch { throw new Error("Invalid JSON in config/extend.md; file left unchanged"); }
  if (!data || Array.isArray(data) || data.version !== 1 ||
      Object.keys(data).some((key) => !["version", "defaults"].includes(key)) ||
      !data.defaults || typeof data.defaults !== "object" || Array.isArray(data.defaults) ||
      Object.entries(data.defaults).some(([key, value]) =>
        !Object.hasOwn(DRAWING_KEYS, key) || !["string", "number", "boolean"].includes(typeof value))) {
    throw new Error("config/extend.md accepts only version 1 and non-secret drawing defaults");
  }
  return Object.fromEntries(Object.entries(data.defaults).map(([key, value]) => [DRAWING_KEYS[key], value]));
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
  const normalized = raw;
  if (!normalized) {
    return DEFAULT_MODE;
  }
  if (!SUPPORTED_MODES.has(normalized)) {
    throw new Error(`${name} 只能是 current`);
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

function normalizeModel(value, name) {
  try { return modelCapabilities(value).id; }
  catch (error) { throw new Error(`${name}：${error.message}`); }
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

  if (background === "transparent") {
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

function parseArgs(argv, dotenvConfig, preferenceDefaults = {}) {
  let taskDefaults = {};
  const configIndex = argv.indexOf("--execution-config");
  if (configIndex !== -1) {
    const configPath = argv[configIndex + 1];
    if (!configPath || configPath.startsWith("-") ||
        argv.lastIndexOf("--execution-config") !== configIndex) {
      throw new Error("--execution-config requires exactly one file");
    }
    const config = JSON.parse(fsSync.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    const taskKeys = [
      "GPT_IMAGE2_MODEL", "GPT_IMAGE2_N", "GPT_IMAGE2_MODE", "GPT_IMAGE2_RESOLUTION",
      "GPT_IMAGE2_ASPECT_RATIO", "GPT_IMAGE2_QUALITY", "GPT_IMAGE2_BACKGROUND",
      "GPT_IMAGE2_OUTPUT_FORMAT", "GPT_IMAGE2_OUTPUT_COMPRESSION",
      "GPT_IMAGE2_MODERATION", "GPT_IMAGE2_SHOW_INFO",
    ];
    taskDefaults = config.request_defaults;
    if (config.schema_version !== 1 ||
        Object.keys(config).some((key) => !EXECUTION_CONFIG_KEYS.has(key)) ||
        hasForbiddenExecutionKey(config) ||
        !taskDefaults || typeof taskDefaults !== "object" ||
        Array.isArray(taskDefaults) || Object.keys(taskDefaults).length !== taskKeys.length ||
        taskKeys.some((key) => !Object.hasOwn(taskDefaults, key)) ||
        Object.values(taskDefaults).some((value) => !["string", "number", "boolean"].includes(typeof value))) {
      throw new Error("Invalid non-secret execution configuration");
    }
    argv = [...argv.slice(0, configIndex), ...argv.slice(configIndex + 2)];
  }
  let promptFlag = null;
  const positionals = [];
  // Resolve overrides before validating, so a CLI correction can repair a bad default.
  const configured = (name, fallback = "") =>
    taskDefaults[name] ?? configuredEnvironmentValue(dotenvConfig, name) ??
      preferenceDefaults[name] ?? fallback;
  const options = {
    model: configured("GPT_IMAGE2_MODEL", DEFAULT_MODEL),
    n: configured("GPT_IMAGE2_N", DEFAULT_N),
    mode: configured("IMAGE_GEN_MODE", DEFAULT_MODE),
    resolution: configured("GPT_IMAGE2_RESOLUTION", DEFAULT_RESOLUTION),
    aspectRatio: configured("GPT_IMAGE2_ASPECT_RATIO", DEFAULT_ASPECT_RATIO),
    quality: configured("GPT_IMAGE2_QUALITY"),
    background: configured("GPT_IMAGE2_BACKGROUND"),
    outputFormat: configured("GPT_IMAGE2_OUTPUT_FORMAT"),
    outputCompression: configured("GPT_IMAGE2_OUTPUT_COMPRESSION"),
    moderation: configured("GPT_IMAGE2_MODERATION"),
    baseUrl: configured("IMAGE_GEN_BASE_URL", DEFAULT_BASE_URL),
    apiKey: configured("FLARE_SUNBURST_API_KEY"),
    bananaApiKey: configured("BANANA_API_KEY"),
    outDir: configured("GPT_IMAGE2_OUT_DIR", "./image_output"),
    timeoutMs: configured("IMAGE_GEN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    maxRetries: configured("IMAGE_GEN_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    minIntervalMs: configured("IMAGE_GEN_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS),
    showInfo: configured("GPT_IMAGE2_SHOW_INFO", false),
    privateMetadata: configured("IMAGE_GEN_PRIVATE_METADATA", false),
    concurrency: configured("IMAGE_GEN_CONCURRENCY", 2),
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
      options.n = parsePositiveInt(readValue(i, arg), "-n", MAX_OUTPUT_IMAGES);
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

    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      throw new Error("不再支持命令行密钥，请在 config/.env 或进程环境变量中设置 FLARE_SUNBURST_API_KEY");
    }

    if (arg === "--private-metadata") {
      options.privateMetadata = true;
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

    if (arg === "--concurrency") {
      options.concurrency = readValue(i, arg);
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--show-info" || arg === "--no-info") {
      options.showInfo = arg === "--show-info";
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
    executionConfig: configIndex !== -1,
    prompt: (promptFlag ?? positionals.join(" ")).trim(),
    model: normalizeModel(options.model, "--model / GPT_IMAGE2_MODEL"),
    n: parsePositiveInt(options.n, "-n / GPT_IMAGE2_N", MAX_OUTPUT_IMAGES),
    mode: normalizeMode(options.mode, "--mode / IMAGE_GEN_MODE"),
    resolution: normalizeOptionalResolution(options.resolution, "--resolution / GPT_IMAGE2_RESOLUTION") || DEFAULT_RESOLUTION,
    aspectRatio: normalizeOptionalAspectRatio(options.aspectRatio, "--aspect-ratio / GPT_IMAGE2_ASPECT_RATIO") || DEFAULT_ASPECT_RATIO,
    quality: normalizeOptionalQuality(options.quality, "--quality / GPT_IMAGE2_QUALITY"),
    background: normalizeOptionalBackground(options.background, "--background / GPT_IMAGE2_BACKGROUND"),
    outputFormat: normalizeOptionalOutputFormat(options.outputFormat, "--output-format / GPT_IMAGE2_OUTPUT_FORMAT"),
    outputCompression: normalizeOptionalOutputCompression(options.outputCompression, "--output-compression / GPT_IMAGE2_OUTPUT_COMPRESSION"),
    moderation: normalizeOptionalModeration(options.moderation, "--moderation / GPT_IMAGE2_MODERATION"),
    timeoutMs: parsePositiveInt(options.timeoutMs, "--timeout-ms / IMAGE_GEN_TIMEOUT_MS", 2_147_483_647),
    maxRetries: parseNonnegativeInt(options.maxRetries, "--max-retries / IMAGE_GEN_MAX_RETRIES", 10),
    minIntervalMs: parseNonnegativeInt(options.minIntervalMs, "--min-interval-ms / IMAGE_GEN_MIN_INTERVAL_MS", 3_600_000),
    showInfo: parseBoolean(options.showInfo, "--show-info / GPT_IMAGE2_SHOW_INFO"),
    privateMetadata: parseBoolean(options.privateMetadata, "--private-metadata / IMAGE_GEN_PRIVATE_METADATA"),
    concurrency: parsePositiveInt(options.concurrency, "--concurrency / IMAGE_GEN_CONCURRENCY", 4),
    apiKey: String(options.apiKey).trim(),
    outDir: resolveOutputDir(String(options.outDir).trim() || "./image_output"),
  };
  const locked = {
    GPT_IMAGE2_MODEL: "model", GPT_IMAGE2_N: "n", GPT_IMAGE2_MODE: "mode",
    GPT_IMAGE2_RESOLUTION: "resolution", GPT_IMAGE2_ASPECT_RATIO: "aspectRatio",
    GPT_IMAGE2_QUALITY: "quality", GPT_IMAGE2_BACKGROUND: "background",
    GPT_IMAGE2_OUTPUT_FORMAT: "outputFormat", GPT_IMAGE2_OUTPUT_COMPRESSION: "outputCompression",
    GPT_IMAGE2_MODERATION: "moderation", GPT_IMAGE2_SHOW_INFO: "showInfo",
  };
  for (const [key, value] of Object.entries(taskDefaults)) {
    if (String(options[locked[key]]) !== String(value)) {
      throw new Error(`CLI option contradicts execution configuration: ${key}`);
    }
  }
  if (!parsedOptions.prompt) throw new Error("缺少有效提示词，请说明要生成什么图片");
  if (!parsedOptions.aspectRatio) {
    parsedOptions.aspectRatio = DEFAULT_ASPECT_RATIO;
  }
  const effective = resolveOutputOptions(parsedOptions);
  const model = validateModelOptions(effective);
  if (model.provider === "banana") {
    effective.apiKey = String(options.bananaApiKey).trim();
  }
  return effective;
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

  const byteLength = payload.length / 4 * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  if (byteLength > MAX_OUTPUT_IMAGE_BYTES) throw new Error("图片大小超过 128MB 限制");
  const raw = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  for (let start = 0; start < payload.length; start += 64 * 1024) {
    const chunk = payload.slice(start, start + 64 * 1024);
    const decoded = Buffer.from(chunk, "base64");
    if (decoded.toString("base64") !== chunk) throw new Error("图片 Base64 编码无效");
    offset += decoded.copy(raw, offset);
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

function validateBaseUrl(value, restrictChannel = false) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error("接口地址必须是完整的 http/https URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || /\/register\/?$/i.test(url.pathname)) {
    throw new Error("请填写 API 基础地址，不要填写注册链接、查询参数或含账号密码的 URL");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!local && url.protocol !== "https:") {
    throw new Error("接口必须使用 HTTPS；仅本地模拟测试允许 HTTP");
  }
  if (!local && url.hostname !== "code.heihuzi.ai") {
    throw new Error("IMAGE_GEN_BASE_URL 是固定服务平台地址，不支持修改；本机模拟测试可使用 localhost 或 127.0.0.1");
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

function displayResult(record, metadataPath, infoSummary) {
  console.log(`result = ${JSON.stringify({
    status: record.status, images: record.images, metadata_path: metadataPath,
    errors: record.errors, warnings: record.warnings,
    ...(infoSummary ? { info_summary: infoSummary } : {}),
  })}`);
  for (const [index, image] of record.images.entries()) {
    const destination = image.path.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\n/g, "%0A").replace(/\r/g, "%0D");
    console.log(`![生成图片 ${index + 1}](<${destination}>)`);
  }
  if (infoSummary) console.log(formatInfoSummary(infoSummary));
}

function redactValue(value, apiKey) {
  if (!apiKey) return value;
  if (typeof value === "string") return value.replaceAll(apiKey, "[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactValue(item, apiKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      name, /api[_-]?key|authorization|access[_-]?token|secret/i.test(name)
        ? "[redacted]" : redactValue(item, apiKey),
    ]));
  }
  return value;
}

function storedRecord(record, privateMetadata) {
  const value = redactRecord(record);
  if (!privateMetadata) return value;
  for (const item of [...(value.reference_images ?? []), ...(value.images ?? [])]) {
    if (item.path) item.path = path.basename(item.path);
  }
  return value;
}

async function updateRecord(metadataPath, record, privateMetadata) {
  const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(storedRecord(record, privateMetadata), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, metadataPath);
  } finally { await fs.unlink(temporaryPath).catch(() => {}); }
}

async function downloadImageURL(url, timeoutMs, baseUrl) {
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("图片下载地址必须是无账号密码的 http/https URL");
  }
  // The service may only direct downloads to the origin the user configured.
  // This also confines local mock requests to their exact configured port.
  if (parsedUrl.origin !== new URL(baseUrl).origin) {
    throw new Error("图片下载地址必须与配置的 API 服务同源；请使用 Base64 返回或检查服务配置");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
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
  if (argv.length === 1 && ["models", "--models"].includes(argv[0])) {
    console.log(JSON.stringify({ models: Object.entries(MODELS).map(([alias, model]) => ({ alias, ...model })) }, null, 2));
    return;
  }
  if (typeof fetch !== "function" || typeof FormData !== "function" || typeof Blob !== "function") {
    throw new Error("运行此技能需要带 fetch/FormData/Blob 的 Node.js，请使用 Node.js 22 或更新版本");
  }
  ensureConfigFiles();
  const dotenvConfig = loadDotEnv(fsSync.existsSync(DOTENV_PATH) ? DOTENV_PATH : LEGACY_DOTENV_PATH);
  for (const value of [
    configuredEnvironmentValue(dotenvConfig, "FLARE_SUNBURST_API_KEY"),
    configuredEnvironmentValue(dotenvConfig, "BANANA_API_KEY"),
  ]) {
    if (value?.trim()) privateValues.add(value.trim());
  }
  const checkConfig = argv.includes("--check-config") || (argv.length === 1 && argv[0] === "check");
  const preferenceDefaults = loadPreferenceDefaults(PREFERENCES_PATH);
  const checkArgs = argv.filter((arg) => !["--check-config", "check"].includes(arg));
  const options = parseArgs(checkConfig ? [...checkArgs, "--prompt", "configuration check", "--dry-run"] : argv,
    dotenvConfig, preferenceDefaults);
  if (options.apiKey) privateValues.add(options.apiKey);
  const model = modelCapabilities(options.model);
  options.baseUrl = validateBaseUrl(options.baseUrl, options.executionConfig);
  if (!options.dryRun && !checkConfig && !hasConfiguredKey(options.apiKey)) {
    throw new Error(`尚未配置 ${model.keyVariable}。请参考 ${path.resolve(__dirname, "../README.md")}，在 ${DOTENV_PATH} 填写。推荐直接填写本机 .env；如果你明确希望提供 API Key，也可以发送给我，我会写入本机配置，不在回复、日志或结果中重复显示`);
  }
  if (checkConfig) {
    console.log(JSON.stringify({
      configured: hasConfiguredKey(options.apiKey), model: options.model, resolution: options.resolution,
      aspect_ratio: options.aspectRatio, quality: options.quality || DEFAULT_CURRENT_QUALITY,
      default_count: options.n, show_info: options.showInfo,
      background: options.background, output_format: options.outputFormat,
      output_compression: options.outputCompression, moderation: options.moderation,
      provider: model.provider, concurrency: options.concurrency,
      providers: {
        gpt: hasConfiguredKey(String(configuredEnvironmentValue(dotenvConfig, "FLARE_SUNBURST_API_KEY") ?? "").trim()),
        banana: hasConfiguredKey(String(configuredEnvironmentValue(dotenvConfig, "BANANA_API_KEY") ?? "").trim()),
      },
    }));
    return;
  }

  console.log(`[${nowText()}] prompt: ${redactValue(options.prompt, options.apiKey)}`);
  const imageSize = model.provider === "gpt" ? resolveOfficialImageSize(options.resolution, options.aspectRatio) : null;
  const hasReferenceImages = options.images.length > 0;
  const referenceImages = hasReferenceImages ? await loadReferenceImages(options.images) : [];
  const quality = options.quality || DEFAULT_CURRENT_QUALITY;
  const requestOptions = { ...options, quality };

  const extra = [
    `model=${options.model}`,
    `resolution=${options.resolution}`,
    `aspect_ratio=${options.aspectRatio}`,
    ...(imageSize ? [`size=${imageSize}`] : []),
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

  const request = model.provider === "banana"
    ? createBananaRequest(requestOptions, referenceImages)
    : createGPTRequest(requestOptions, referenceImages, imageSize);
  const requestBody = request.summary;
  let elapsedSeconds = 0;

  if (options.dryRun) {
    console.log(`[${nowText()}] dry-run url: ${request.url}`);
      console.log(JSON.stringify(redactValue(hasReferenceImages ? {
        fields: requestBody,
        reference_images: referenceImages.map((image) => ({
          path: image.path,
          filename: image.filename,
          mime_type: image.mimeType,
          size_bytes: image.sizeBytes,
        })),
        output_count: 1,
      } : model.provider === "banana" ? {
        fields: requestBody, request_count: request.count, concurrency: options.concurrency,
        request_bytes: request.makeBody().length,
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
    requested_aspect_ratio: options.aspectRatio,
    requested_count: hasReferenceImages ? 1 : options.n,
    provider: model.provider,
    subrequests: Array.from({ length: request.count }, (_, index) => ({
      index: index + 1, status: "queued", request: { model: options.model },
    })),
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
  await fs.writeFile(metadataPath, `${JSON.stringify(storedRecord(record, options.privateMetadata), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const start = Date.now();
  const deadline = start + options.timeoutMs;
  let metadataSaved = true;
  let persistence = Promise.resolve();
  const persist = () => {
    persistence = persistence.then(() => updateRecord(metadataPath, record, options.privateMetadata)).catch(() => {
      if (metadataSaved) record.warnings.push("未能更新本地生成记录；保留已保存图片，未开始的生成请求将停止");
      metadataSaved = false;
    });
    return persistence;
  };
  console.log("生成中，请勿重复提交；超时或部分失败不会自动重新生图。");
  const saveImage = async (index, img, parsed, requestIndex, downloadDeadline) => {
    try {
      let image;
      let source;
      if (img?.b64_json != null && img.b64_json !== "") {
        image = decodeImageField(img.b64_json);
        source = "base64";
      } else if (typeof img?.url === "string" && img.url.trim()) {
        const remaining = downloadDeadline - Date.now();
        if (remaining <= 0) throw new Error("图片下载超时；不会自动重新生图");
        image = await downloadImageURL(img.url, remaining, options.baseUrl);
        source = "url";
      } else {
        throw new Error("没有可用图片字段（b64_json 或 url）");
      }
      const { raw, mimeType, width, height } = image;
      const filename = path.join(
        options.outDir,
        `gpt-image2_${runId}_${requestIndex + 1}_${index + 1}${suffixFromMime(mimeType)}`,
      );
      const handle = await fs.open(filename, "wx");
      try {
        for (let offset = 0; offset < raw.length; offset += 1024 * 1024) {
          await handle.writeFile(raw.subarray(offset, offset + 1024 * 1024));
        }
      } finally { await handle.close(); }
      const savedImage = redactValue({
        path: filename, mime_type: mimeType, bytes: raw.length, source,
        width: width ?? null, height: height ?? null,
        model: img.model ?? parsed.model ?? options.model,
        revised_prompt: img.revised_prompt ?? null,
        request_index: requestIndex + 1, image_index: index + 1,
      }, options.apiKey);
      const [requestedWidth, requestedHeight] = imageSize ? imageSize.split("x").map(Number) : [];
      if (imageSize && (width !== requestedWidth || height !== requestedHeight)) {
        savedImage.warning = `请求尺寸 ${imageSize}，实际返回 ${width}x${height}，请检查比例与清晰度`;
      }
      if (!imageSize) {
        const [w, h] = options.aspectRatio.split(":").map(Number);
        if (Math.abs(width / height - w / h) > (w / h) * 0.02) {
          savedImage.warning = `请求比例 ${options.aspectRatio}，实际返回 ${width}x${height}，请检查构图`;
        }
      }
      console.log(`  [${index}] saved ${filename} (${raw.length.toLocaleString()} bytes, ${mimeType})`);
      return { image: savedImage };
    } catch (error) {
      return {
        error: `请求 ${requestIndex + 1} 图片 ${index + 1}：${error.message.replaceAll(options.apiKey, "[redacted]")}`,
        recovery: typeof img?.url === "string" ? {
          index: index + 1, url: redactValue(img.url, options.apiKey),
        } : null,
      };
    }
  };
  let nextRequest = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, request.count) }, async () => {
    while (nextRequest < request.count) {
      const requestIndex = nextRequest++;
      const subrequest = record.subrequests[requestIndex];
      let result;
      try {
        if (Date.now() >= deadline || !metadataSaved) {
          subrequest.status = "not_sent";
          throw new Error("整体生成超时或记录不可写，未开始的请求没有发送");
        }
        subrequest.status = "pending";
        await persist();
        if (!metadataSaved) {
          subrequest.status = "not_sent";
          throw new Error("本地记录不可写，没有发送生成请求");
        }
        result = await requestImageJSON(request.url, request.makeBody, request.contentType, { ...options, deadline });
        const parsed = request.parse(result.body);
        Object.assign(subrequest, redactValue({
          ...result.metadata, usage: parsed.usage, response_model: parsed.model, response_created: parsed.created,
        }, options.apiKey));
        if (request.count === 1) Object.assign(record, redactValue({
          ...result.metadata, usage: parsed.usage, response_model: parsed.model, response_created: parsed.created,
        }, options.apiKey));
        elapsedSeconds = Math.max(elapsedSeconds, (Date.now() - start) / 1000);
        if (!parsed.data.length) throw new Error(parsed.error ?? "接口返回了空图片结果，没有可保存的图片");
        const downloadDeadline = Date.now() + options.timeoutMs;
        let nextImage = 0;
        const outcomes = new Array(parsed.data.length);
        await Promise.all(Array.from({ length: Math.min(3, parsed.data.length) }, async () => {
          while (nextImage < parsed.data.length) {
            const index = nextImage++;
            outcomes[index] = await saveImage(index, parsed.data[index], parsed, requestIndex, downloadDeadline);
          }
        }));
        for (const outcome of outcomes) {
          if (outcome.image) {
            record.images.push(outcome.image);
            if (outcome.image.warning) record.warnings.push(outcome.image.warning);
            if (outcome.image.model !== options.model) record.warnings.push(`请求模型 ${options.model}，服务报告模型 ${outcome.image.model}`);
            if (options.outputFormat && suffixFromMime(outcome.image.mime_type) !==
                { png: ".png", jpeg: ".jpg", webp: ".webp" }[options.outputFormat]) {
              record.warnings.push(`请求格式 ${options.outputFormat}，实际返回 ${outcome.image.mime_type}，已按真实格式保存`);
            }
          } else {
            record.errors.push(outcome.error);
            if (outcome.recovery) record.recoverable_images.push(outcome.recovery);
          }
        }
        subrequest.status = outcomes.some((outcome) => outcome.error)
          ? (outcomes.some((outcome) => outcome.image) ? "partial" : "failed") : "success";
      } catch (error) {
        if (error.metadata?.submitted === false) subrequest.status = "not_sent";
        else if (subrequest.status !== "not_sent") subrequest.status = "failed";
        subrequest.error = error.message.replaceAll(options.apiKey, "[redacted]");
        Object.assign(subrequest, redactValue(error.metadata ?? {}, options.apiKey));
        if (request.count === 1) Object.assign(record, redactValue(error.metadata ?? {}, options.apiKey));
        record.errors.push(`请求 ${requestIndex + 1}：${subrequest.error}`);
      } finally {
        result = null;
        await persist();
      }
    }
  }));
  record.images.sort((a, b) => a.request_index - b.request_index || a.image_index - b.image_index);
  if (request.count > 1) {
    record.usage = {};
    for (const key of ["input_tokens", "output_tokens"]) {
      const values = record.subrequests.map((item) => item.usage?.[key]);
      record.usage[key] = values.every((value) => Number.isSafeInteger(value) && value >= 0)
        ? values.reduce((a, b) => a + b, 0) : null;
    }
  }
  record.elapsed_seconds = (Date.now() - start) / 1000;
  console.log(`[${nowText()}] 耗时 ${record.elapsed_seconds.toFixed(1)}s`);
  console.log(`resp.created = ${record.response_created ?? null}`);
  console.log(`resp.usage = ${JSON.stringify(record.usage ?? null)}`);

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
  await persist();
  const infoSummary = options.showInfo ? buildInfoSummary(record) : undefined;
  displayResult(record, metadataSaved ? metadataPath : null, infoSummary);
  if (record.errors.length) throw new Error(record.errors.join("；"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
