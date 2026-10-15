import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const unavailable = (reason, status = "unavailable") => ({ status, amount: null, currency: "USD", reason });

function requestCandidates(record) {
  const splitIDs = (value) => typeof value === "string"
    ? value.split(",").map((id) => id.trim()).filter((id) => id && id.length <= 256).slice(0, 3)
    : [];
  const clients = splitIDs(record.client_request_id);
  if (clients.length) return [...new Set(clients.map((id) => id.startsWith("client:") ? id : `client:${id}`))];
  return [...new Set([...splitIDs(record.billing_request_id), ...splitIDs(record.request_id)])].slice(0, 3);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tokensMatch(row, usage) {
  for (const kind of ["input", "output"]) {
    const expected = validCount(usage?.[`${kind}_tokens`]);
    if (expected === null) continue;
    const total = validCount(row[`${kind}_tokens`]);
    const images = validCount(row[`image_${kind}_tokens`]) ?? 0;
    // Different ledger versions store image tokens either within or next to total tokens.
    if (total === null || (total !== expected && total + images !== expected)) return false;
  }
  return true;
}

async function verifyBillingTarget(cliPath, baseUrl) {
  await fs.access(cliPath);
  const envPath = path.resolve(path.dirname(cliPath), "..", ".env");
  const content = await fs.readFile(envPath, "utf8");
  const bases = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^(HEIHUZI_ADMIN_BASE_URL|SUB2API_BASE_URL)\s*=\s*(.*)$/);
    if (match) bases[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const target = bases.HEIHUZI_ADMIN_BASE_URL || bases.SUB2API_BASE_URL || "https://code.heihuzi.ai";
  return new URL(target).origin === new URL(baseUrl).origin;
}

export async function lookupActualCost(record, options) {
  try {
    if (!await verifyBillingTarget(options.costLookupCLI, options.baseUrl)) return unavailable("billing_target_mismatch");
  } catch {
    return unavailable("billing_lookup_not_configured");
  }
  const ids = requestCandidates(record);
  if (!ids.length) return unavailable("missing_request_id");
  const deadline = Date.now() + 8000;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const id of ids) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return unavailable("billing_not_ready", "pending");
        const query = new URLSearchParams({ request_id: id, page_size: "5" });
        // Use the existing read-only admin wrapper. It owns its credentials;
        // no key is copied to the image skill's environment or command line.
        const { stdout } = await execFileAsync(process.execPath, [
          options.costLookupCLI, "api", "GET", `/admin/usage?${query}`,
        ], { timeout: Math.min(5000, remaining), maxBuffer: 4 * 1024 * 1024 });
        const payload = JSON.parse(stdout);
        const data = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
        if (!Array.isArray(data?.items)) return unavailable("invalid_billing_response");
        const rows = data.items.filter((row) => row.request_id === id || row.upstream_request_id === id);
        if (!rows.length) continue;
        if (rows.length !== 1) return unavailable("ambiguous_billing_record");
        const row = rows[0];
        if (!options.apiKey || row.api_key?.key !== options.apiKey || row.model !== record.request?.model || !tokensMatch(row, record.usage)) {
          return unavailable("billing_record_mismatch");
        }
        if (typeof row.actual_cost !== "number" || !Number.isFinite(row.actual_cost) || row.actual_cost < 0) {
          return unavailable("invalid_actual_cost");
        }
        // Explicit whitelist: no multiplier, base price, account details or keys.
        return {
          status: "confirmed", amount: row.actual_cost, currency: "USD",
          source: "usage_log.actual_cost", usage_log_id: row.id,
        };
      }
      if (attempt < 2) await sleep(Math.min(500 * (attempt + 1), Math.max(0, deadline - Date.now())));
    }
    return unavailable("billing_not_ready", "pending");
  } catch {
    // Cost lookup must never turn a successfully saved image into a failure.
    return unavailable("billing_lookup_failed");
  }
}

export function buildCostSummary(record) {
  const responseModels = [...new Set((record.images ?? []).map((image) => image.model).filter(Boolean))];
  const dimensions = (record.images ?? []).map((image) =>
    Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0
      ? `${image.width} × ${image.height}` : null);
  const actualResolution = dimensions.length && dimensions.every(Boolean)
    ? [...new Set(dimensions)].join("、") : null;
  return {
    model: responseModels.length ? responseModels.join("、") : record.response_model ?? record.request?.model ?? "未知",
    resolution: actualResolution ?? (record.request?.size ? `${record.request.size.replace(/x/g, " × ")}（请求尺寸）` : "未提供"),
    quality: record.request?.quality || "default",
    input_tokens: validCount(record.usage?.input_tokens),
    output_tokens: validCount(record.usage?.output_tokens),
    generation_cost: {
      status: record.cost?.status ?? "unavailable",
      amount: record.cost?.status === "confirmed" ? record.cost.amount : null,
      currency: record.cost?.currency ?? "USD",
    },
  };
}

export function formatCostSummary(summary) {
  const names = {
    "gpt-image-2.5-flare": "GPT Image 2.5 Flare",
    "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
    "gpt-image-2": "GPT Image 2",
  };
  const qualities = {
    auto: "自动（auto）", low: "低（low）", medium: "中（medium）", high: "高（high）",
    xhigh: "超高（xhigh）", max: "最高（max）", default: "默认",
  };
  let fee = "暂未查到";
  if (summary.generation_cost.status === "confirmed") {
    const amount = summary.generation_cost.amount.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    fee = `$${amount === "0" ? "0.00" : amount}`;
  }
  return [
    `模型：${names[summary.model] ?? summary.model}`,
    `分辨率：${summary.resolution}`,
    `质量：${qualities[summary.quality] ?? summary.quality}`,
    `输入/输出 token：${summary.input_tokens ?? "未提供"} / ${summary.output_tokens ?? "未提供"}`,
    `生图费用：${fee}`,
  ].join("\n");
}
