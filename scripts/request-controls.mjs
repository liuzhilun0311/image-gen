import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export async function readLimitedBody(response, maximumBytes) {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`响应大小超过 ${Math.floor(maximumBytes / 1024 / 1024)}MB 限制`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`响应大小超过 ${Math.floor(maximumBytes / 1024 / 1024)}MB 限制`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}

// Optional pacing is shared by local processes using the same host and key.
// It limits request starts, not images or the upstream account's total quota.
async function waitForRequestSlot(url, apiKey, intervalMs, deadline) {
  if (!intervalMs) return;
  const bucket = createHash("sha256").update(`${new URL(url).origin}\0${apiKey}`).digest("hex");
  const dir = path.join(os.tmpdir(), "gpt-image2-request-queue");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dir, `${bucket}.json`);
  const lockPath = `${statePath}.lock`;
  let lock;
  while (!lock) {
    if (Date.now() >= deadline) throw new Error("等待本机请求队列超时");
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A killed process must not leave the queue locked permanently.
      try {
        const owner = Number(await fs.readFile(lockPath, "utf8"));
        let abandoned = false;
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (error) { abandoned = error.code === "ESRCH"; }
        } else {
          abandoned = Date.now() - (await fs.stat(lockPath)).mtimeMs > 10_000;
        }
        if (abandoned) await fs.unlink(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await sleep(50);
    }
  }

  let slot;
  try {
    await lock.writeFile(String(process.pid));
    let nextAvailable = 0;
    try {
      nextAvailable = Number(await fs.readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    slot = Math.max(Date.now(), Number.isFinite(nextAvailable) ? nextAvailable : 0);
    if (slot >= deadline) throw new Error("本机请求队列等待时间超过本次超时限制");
    await fs.writeFile(statePath, String(slot + intervalMs), { mode: 0o600 });
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
  if (slot > Date.now()) await sleep(slot - Date.now());
}

function responseMetadata(response) {
  const rateLimits = {};
  for (const [key, value] of response.headers) {
    if (key.startsWith("x-ratelimit-") || key === "retry-after") rateLimits[key] = value;
  }
  return {
    request_id: response.headers.get("x-request-id"),
    client_request_id: response.headers.get("x-client-request-id"),
    rate_limits: rateLimits,
  };
}

function retryDelay(response, attempt) {
  const value = response.headers.get("retry-after");
  if (value !== null && value.trim() !== "") {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

export async function requestImageJSON(url, makeBody, contentType, options) {
  const deadline = Date.now() + options.timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    await waitForRequestSlot(url, options.apiKey, options.minIntervalMs, deadline);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("图片请求超时；没有自动重发生成请求");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let response;
    let body;
    let text;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(contentType ? { "content-type": contentType } : {}),
        },
        body: makeBody(),
        signal: controller.signal,
        redirect: "error",
      });
      text = (await readLimitedBody(response, response.ok ? 192 * 1024 * 1024 : 1024 * 1024)).toString("utf8");
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    } catch (error) {
      const failure = new Error(`图片请求失败或超时，未自动重发，请先核对生成记录：${error.message}`);
      failure.metadata = { ...(response ? responseMetadata(response) : {}), attempts: attempt };
      throw failure;
    } finally {
      clearTimeout(timer);
    }

    const metadata = { ...responseMetadata(response), attempts: attempt };
    if (response.ok) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        const error = new Error("接口返回了空响应或非 JSON 对象");
        error.metadata = metadata;
        throw error;
      }
      return { body, metadata };
    }

    const detail = (body ? JSON.stringify(body) : text).slice(0, 2000).replaceAll(options.apiKey, "[redacted]");
    const error = new Error(`HTTP ${response.status}: ${detail}`);
    error.request_id = metadata.request_id;
    error.metadata = metadata;
    const quotaError = /quota|billing|balance|credit|recharge|余额|额度不足/i.test(
      `${body?.error?.code ?? ""} ${body?.error?.type ?? ""} ${body?.error?.message ?? ""}`,
    );
    // Only a definite rate-limit rejection is retried. Timeouts/5xx can have
    // already generated a billable image and must not be repeated blindly.
    if (response.status !== 429 || quotaError || attempt > options.maxRetries) throw error;
    const delayMs = retryDelay(response, attempt);
    if (Date.now() + delayMs >= deadline) {
      error.message += "；服务要求的等待时间超过本次超时限制";
      throw error;
    }
    console.log(`收到 429 限流，等待 ${(delayMs / 1000).toFixed(1)} 秒后重试（${attempt}/${options.maxRetries}）`);
    await sleep(delayMs);
  }
}
