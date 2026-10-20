import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUm1bBwMDAxAAGAA3gATBe/P02AAAAAElFTkSuQmCC",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDOooorQ+LP/9k=",
  webp: "UklGRjYAAABXRUJQVlA4ICoAAABwAQCdASoCAAIAAUAmJaACdAFAAAD+6Wik3Yd//qcf/9ZX//zK/2UgAAA=",
};
const prompt = ["--prompt", "local regression test"];
const imageResponse = (format = "png") => ({ data: [{ b64_json: fixtures[format] }] });
const sendJSON = (res, body, status = 200, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const taskDefaults = {
  GPT_IMAGE2_MODEL: "gpt-image-2.5-sunburst", GPT_IMAGE2_N: 1,
  GPT_IMAGE2_MODE: "current", GPT_IMAGE2_RESOLUTION: "1k",
  GPT_IMAGE2_ASPECT_RATIO: "4:3", GPT_IMAGE2_QUALITY: "medium",
  GPT_IMAGE2_BACKGROUND: "", GPT_IMAGE2_OUTPUT_FORMAT: "",
  GPT_IMAGE2_OUTPUT_COMPRESSION: "", GPT_IMAGE2_MODERATION: "",
  GPT_IMAGE2_SHOW_INFO: false,
};

test("task snapshot overrides environment and clears optional fields", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = path.join(h.dir, "execution.json");
  await fs.writeFile(config, JSON.stringify({ schema_version: 1, request_defaults: taskDefaults }));
  const r = await h.run([...prompt, "--execution-config", config], {
    GPT_IMAGE2_MODEL: "invalid-default", GPT_IMAGE2_QUALITY: "max",
    GPT_IMAGE2_BACKGROUND: "transparent", GPT_IMAGE2_OUTPUT_FORMAT: "webp",
    GPT_IMAGE2_OUTPUT_COMPRESSION: "99", GPT_IMAGE2_MODERATION: "low",
    GPT_IMAGE2_SHOW_INFO: "true",
  });
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(h.requests[0].body.toString());
  assert.equal(body.model, taskDefaults.GPT_IMAGE2_MODEL);
  assert.equal(body.quality, "medium");
  assert.equal(body.n, 1);
  for (const key of ["background", "output_format", "output_compression", "moderation"]) {
    assert.equal(Object.hasOwn(body, key), false);
  }
  assert.equal(r.result.info_summary, undefined);
});

test("invalid snapshots and contradictory overrides never send a request", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = path.join(h.dir, "execution.json");
  for (const defaults of [
    { ...taskDefaults, GPT_IMAGE2_API_KEY: "forbidden" },
    { ...taskDefaults, GPT_IMAGE2_BASE_URL: "https://attacker.invalid" },
    { GPT_IMAGE2_MODEL: "gpt-image-2.5-flare" },
  ]) {
    await fs.writeFile(config, JSON.stringify({ schema_version: 1, request_defaults: defaults }));
    assert.notEqual((await h.run([...prompt, "--execution-config", config])).code, 0);
  }
  await fs.writeFile(config, JSON.stringify({ schema_version: 1, request_defaults: taskDefaults }));
  assert.notEqual((await h.run([...prompt, "--execution-config", config, "--quality", "max"])).code, 0);
  assert.equal(h.requests.length, 0);
});

test("execution snapshots reject secrets in caller metadata but accept documented task metadata", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = path.join(h.dir, "execution.json");
  for (const extra of [
    { schema_version: 1, request_defaults: taskDefaults, storage: { api_key: "forbidden" } },
    { schema_version: 1, request_defaults: taskDefaults, service: { base_url: "https://attacker.invalid" } },
  ]) {
    await fs.writeFile(config, JSON.stringify(extra));
    assert.notEqual((await h.run([...prompt, "--execution-config", config])).code, 0);
  }
  await fs.writeFile(config, JSON.stringify({
    schema_version: 1, request_defaults: taskDefaults,
    prompt_settings: { style: "minimal" }, prompt_supplements: {},
    references: [], scheduling: { batch_size: 1 },
    storage: { output_dir: "imgs" }, limits: "caller-enforced",
  }));
  const r = await h.run([...prompt, "--execution-config", config]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests.length, 1);
});

test("caller-provided service environment remains authoritative over task drawing snapshot", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = path.join(h.dir, "execution.json");
  await fs.writeFile(config, JSON.stringify({ schema_version: 1, request_defaults: taskDefaults }));
  const r = await h.run([...prompt, "--execution-config", config], {
    GPT_IMAGE2_API_KEY: "external-caller-key",
    GPT_IMAGE2_BASE_URL: h.baseUrl,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].headers.authorization, "Bearer external-caller-key");
});

test("configuration inspection reads only this skill and never sends requests", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  await fs.writeFile(path.join(h.dir, ".env"),
    `GPT_IMAGE2_API_KEY=local-config-key\nGPT_IMAGE2_MODEL=sunburst\n`);
  const r = await h.run(["--check-config"], { GPT_IMAGE2_API_KEY: undefined });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).model, "gpt-image-2.5-sunburst");
  assert.doesNotMatch(r.stdout, /local-config-key|local-test-key|127\.0\.0\.1/);
  const missing = await h.run(["--check-config"], { GPT_IMAGE2_API_KEY: "" });
  assert.equal(missing.code, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).configured, false);
  assert.equal(h.requests.length, 0);
});

test("provided channel is required and metadata sensitive fields are redacted", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, {
    data: [{ b64_json: fixtures.png, revised_prompt: "local-test-key" }],
    usage: { input_tokens: 1, authorization: "another-secret-value" },
  }));
  const config = path.join(h.dir, "execution.json");
  await fs.writeFile(config, JSON.stringify({ schema_version: 1, request_defaults: taskDefaults }));
  for (const base of ["http://code.heihuzi.ai", "https://other.invalid"]) {
    assert.notEqual((await h.run([...prompt, "--execution-config", config],
      { GPT_IMAGE2_BASE_URL: base })).code, 0);
  }
  assert.equal(h.requests.length, 0);
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  const metadata = await fs.readFile(r.result.metadata_path, "utf8");
  assert.doesNotMatch(r.stdout + r.stderr + metadata, /local-test-key|another-secret-value/);
});

test("standalone configuration rejects a non-platform base URL", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run([...prompt, "--dry-run", "--base-url", "https://standalone.invalid"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /固定服务平台地址/);
  assert.equal(h.requests.length, 0);
});

async function harness(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image2-test-"));
  const runtimeDir = path.join(dir, "scripts");
  await fs.mkdir(runtimeDir);
  const outDir = path.join(dir, "images with spaces");
  // Copy executable code only: tests never read a user's .env or use real keys.
  for (const name of ["gpt-image2.mjs", "request-controls.mjs", "info-summary.mjs", "image-info.mjs",
    "model-capabilities.mjs", "gpt-image.mjs", "banana-image.mjs"]) {
    await fs.copyFile(path.join(scriptsDir, name), path.join(runtimeDir, name));
  }
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks), time: Date.now() };
      requests.push(request);
      await handler(request, res, requests.length);
    } catch (error) {
      sendJSON(res, { error: { message: error.message } }, 500);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const run = (args = [], envOverrides = {}) => new Promise((resolve, reject) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !name.startsWith("GPT_IMAGE2_") &&
      !name.startsWith("IMAGE_GEN_") &&
      !name.startsWith("FLARE_SUNBURST_") &&
      !name.startsWith("BANANA_")));
    const child = spawn(process.execPath, [path.join(runtimeDir, "gpt-image2.mjs"), ...args], {
      cwd: dir,
      env: {
        ...cleanEnv, TMPDIR: dir, GPT_IMAGE2_API_KEY: "local-test-key",
        GPT_IMAGE2_BASE_URL: baseUrl, GPT_IMAGE2_OUT_DIR: outDir, GPT_IMAGE2_TIMEOUT_MS: "10000",
        ...envOverrides,
      },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.split("\n").find((line) => line.startsWith("result = "));
      resolve({ code, stdout, stderr, result: line ? JSON.parse(line.slice(9)) : null });
    });
  });
  return { dir: runtimeDir, root: dir, outDir, baseUrl, requests, run };
}

async function preferenceFixture(h, defaults) {
  const config = path.join(h.root, "config");
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, "extend.md"),
    "# Preferences\n\n```json\n" + JSON.stringify({ version: 1, defaults }) + "\n```\n");
  return config;
}

test("canonical runtime config and preferences work without content-gen or Python", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = await preferenceFixture(h, {
    model: "sunburst", n: 1, resolution: "2k", aspect_ratio: "16:9", quality: "high",
    output_format: "png", show_info: false,
  });
  await fs.writeFile(path.join(config, ".env"),
    `GPT_IMAGE2_API_KEY=canonical-local-key\nGPT_IMAGE2_BASE_URL=${h.baseUrl}\n`);
  await fs.writeFile(path.join(h.dir, ".env"), "GPT_IMAGE2_API_KEY=legacy-local-key\n");
  const r = await h.run(prompt, { GPT_IMAGE2_API_KEY: undefined, GPT_IMAGE2_BASE_URL: undefined });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests[0].headers.authorization, "Bearer canonical-local-key");
  const body = JSON.parse(h.requests[0].body);
  assert.equal(body.model, "gpt-image-2.5-sunburst");
  assert.equal(body.size, "2048x1152");
  assert.equal(body.quality, "high");
  assert.equal(body.output_format, "png");
  assert.doesNotMatch(r.stdout + r.stderr, /canonical-local-key|legacy-local-key/);
});

test("new IMAGE_GEN runtime names and provider key work", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run(prompt, {
    GPT_IMAGE2_API_KEY: undefined,
    GPT_IMAGE2_BASE_URL: undefined,
    IMAGE_GEN_BASE_URL: h.baseUrl,
    IMAGE_GEN_MODE: "current",
    IMAGE_GEN_TIMEOUT_MS: "10000",
    IMAGE_GEN_MAX_RETRIES: "0",
    IMAGE_GEN_MIN_INTERVAL_MS: "0",
    IMAGE_GEN_CONCURRENCY: "1",
    FLARE_SUNBURST_API_KEY: "new-provider-key",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests[0].headers.authorization, "Bearer new-provider-key");
});

test("missing config files are initialized from their examples", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = path.join(h.root, "config");
  await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, ".env.example"),
    `FLARE_SUNBURST_API_KEY=\nIMAGE_GEN_BASE_URL=${h.baseUrl}\n`);
  await fs.writeFile(path.join(config, "extend.example.md"),
    "# Defaults\n\n```json\n{\"version\":1,\"defaults\":{\"model\":\"gpt-image-2.5-flare\",\"n\":1}}\n```\n");
  const r = await h.run(["--check-config"], {
    GPT_IMAGE2_API_KEY: "",
    GPT_IMAGE2_BASE_URL: undefined,
    IMAGE_GEN_BASE_URL: undefined,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).model, "gpt-image-2.5-flare");
  assert.equal(await fs.readFile(path.join(config, ".env"), "utf8"),
    `FLARE_SUNBURST_API_KEY=\nIMAGE_GEN_BASE_URL=${h.baseUrl}\n`);
  assert.equal(await fs.readFile(path.join(config, "extend.md"), "utf8"),
    "# Defaults\n\n```json\n{\"version\":1,\"defaults\":{\"model\":\"gpt-image-2.5-flare\",\"n\":1}}\n```\n");
});

const bananaResponse = (overrides = {}) => ({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: fixtures.png } }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 10, thoughtsTokenCount: 2 },
  ...overrides,
});
const bananaPrompt = [...prompt, "--model", "banana"];
const bananaEnv = { BANANA_API_KEY: "banana-local-key" };

test("Banana adapter sends generateContent with its own key and normalizes usage", async (t) => {
  const h = await harness(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer banana-local-key");
    assert.equal(req.url, "/v1beta/models/gemini-nano-banana-2.1:generateContent");
    const payload = JSON.parse(req.body);
    assert.equal(payload.contents[0].parts[0].text, "local regression test");
    assert.deepEqual(payload.generationConfig, {
      responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K", aspectRatio: "1:1" },
      thinkingConfig: { thinkingLevel: "minimal" },
    });
    assert.equal(payload.n, undefined);
    sendJSON(res, bananaResponse());
  });
  const r = await h.run(bananaPrompt, bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.images.length, 1);
  const text = await fs.readFile(r.result.metadata_path, "utf8");
  assert.deepEqual(JSON.parse(text).usage, { input_tokens: 7, output_tokens: 12 });
  assert.doesNotMatch(text + r.stdout + r.stderr, /banana-local-key|local-test-key|iVBORw0KGgo/);
});

test("legacy dotenv drawing defaults, environment and CLI retain priority over preferences", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  await preferenceFixture(h, { model: "flare", quality: "low", background: "opaque" });
  await fs.writeFile(path.join(h.dir, ".env"), "GPT_IMAGE2_MODEL=sunburst\nGPT_IMAGE2_QUALITY=medium\n");
  let r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(h.requests[0].body).model, "gpt-image-2.5-sunburst");
  assert.equal(JSON.parse(h.requests[0].body).quality, "medium");
  r = await h.run([...prompt, "--quality", "max"], {
    GPT_IMAGE2_MODEL: "flare", GPT_IMAGE2_BACKGROUND: "", GPT_IMAGE2_QUALITY: "high",
  });
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(h.requests[1].body);
  assert.equal(body.model, "gpt-image-2.5-flare");
  assert.equal(body.quality, "max");
  assert.equal(Object.hasOwn(body, "background"), false);
});

test("task snapshots override preferences without updating preference files", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = await preferenceFixture(h, { model: "flare", n: 4, quality: "max", background: "transparent" });
  const preferenceFile = path.join(config, "extend.md");
  const before = await fs.readFile(preferenceFile);
  const snapshot = path.join(h.dir, "execution.json");
  await fs.writeFile(snapshot, JSON.stringify({ schema_version: 1, request_defaults: taskDefaults }));
  const r = await h.run([...prompt, "--execution-config", snapshot]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(h.requests[0].body).n, 1);
  assert.equal(JSON.parse(h.requests[0].body).quality, "medium");
  assert.deepEqual(await fs.readFile(preferenceFile), before);
});

test("malformed or service-bearing preferences stop before requests and remain unchanged", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const config = await preferenceFixture(h, { api_key: "fake-sensitive-value" });
  const preferenceFile = path.join(config, "extend.md");
  for (const text of [await fs.readFile(preferenceFile, "utf8"), "# Bad\n```json\ninvalid\n```\n"]) {
    await fs.writeFile(preferenceFile, text);
    const r = await h.run(prompt);
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /fake-sensitive-value/);
    assert.equal(await fs.readFile(preferenceFile, "utf8"), text);
  }
  assert.equal(h.requests.length, 0);
});

for (const format of ["png", "jpeg", "webp"]) {
  test(`pure Base64 ${format}: actual extension, usage record, inline image`, async (t) => {
    const usage = { input_tokens: 7, output_tokens: 12 };
    const h = await harness(t, (_req, res) => sendJSON(res, { ...imageResponse(format), usage }, 200, {
      "x-request-id": "req-test", "x-ratelimit-remaining-requests": "99",
    }));
    const r = await h.run([...prompt, "--output-format", format]);
    assert.equal(r.code, 0, r.stderr);
    const file = r.result.images[0].path;
    assert.equal(path.extname(file), format === "jpeg" ? ".jpg" : `.${format}`);
    assert.deepEqual(await fs.readFile(file), Buffer.from(fixtures[format], "base64"));
    assert.equal(r.result.images[0].width, 2);
    assert.equal(r.result.images[0].height, 2);
    assert.ok(r.stdout.includes(`![生成图片 1](<${file}>)`));
    assert.ok(r.stdout.includes('resp.usage = {"input_tokens":7,"output_tokens":12}'));
    const recordText = await fs.readFile(r.result.metadata_path, "utf8");
    const record = JSON.parse(recordText);
    assert.deepEqual(record.usage, usage);
    assert.equal(record.request_id, "req-test");
    assert.equal(record.rate_limits["x-ratelimit-remaining-requests"], "99");
    assert.equal(record.request.output_format, format);
    assert.equal(record.attempts, 1);
    assert.ok(!recordText.includes("local-test-key"));
  });
}

test("data URL uses actual bytes rather than a misleading MIME label", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, { data: [{ b64_json: `data:image/png;base64,${fixtures.jpeg}` }] }));
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(path.extname(r.result.images[0].path), ".jpg");
});

for (const [name, body] of [
  ["empty data", { data: [] }], ["missing data", {}], ["missing payload", { data: [{}] }],
  ["empty Base64", { data: [{ b64_json: "  " }] }], ["invalid Base64", { data: [{ b64_json: "!!!" }] }],
  ["non-image bytes", { data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }],
]) {
  test(`${name}: fail and retain error metadata without creating an image`, async (t) => {
    const h = await harness(t, (_req, res) => sendJSON(res, body));
    const r = await h.run(prompt);
    assert.equal(r.code, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(r.result.status, "failed");
    assert.equal(r.result.images.length, 0);
    assert.ok(r.result.errors.length);
    assert.equal((await fs.readdir(h.outDir)).length, 1);
  });
}

test("missing or blank prompts and fractional counts never send a request", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const args of [[], ["--prompt", "   "], [...prompt, "-n", "1.5"]]) {
    const r = await h.run(args);
    assert.equal(r.code, 1);
  }
  assert.equal(h.requests.length, 0);
});

test("partial responses preserve valid images and fail explicitly", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, { data: [...imageResponse().data, {}] }));
  const r = await h.run([...prompt, "-n", "2"]);
  assert.equal(r.code, 1);
  assert.equal(r.result.status, "partial");
  assert.equal(r.result.images.length, 1);
  assert.deepEqual(await fs.readFile(r.result.images[0].path), Buffer.from(fixtures.png, "base64"));
});

test("fewer images than requested is not reported as full success", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run([...prompt, "-n", "2"]);
  assert.equal(r.code, 1);
  assert.equal(r.result.status, "partial");
});

test("429 honors Retry-After and records the successful retry", async (t) => {
  const h = await harness(t, (_req, res, count) => count === 1
    ? sendJSON(res, { error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "0.08" })
    : sendJSON(res, imageResponse()));
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].time - h.requests[0].time >= 75);
  assert.equal(JSON.parse(await fs.readFile(r.result.metadata_path, "utf8")).attempts, 2);
});

test("429 retries stop at the configured maximum", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, { error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "0" }));
  const r = await h.run([...prompt, "--max-retries", "2"]);
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 3);
});

for (const [status, code] of [[401, "invalid_api_key"], [500, "server_error"], [429, "insufficient_quota"]]) {
  test(`HTTP ${status} ${code} is not blindly retried`, async (t) => {
    const h = await harness(t, (_req, res) => sendJSON(res, { error: { code } }, status));
    assert.equal((await h.run(prompt)).code, 1);
    assert.equal(h.requests.length, 1);
  });
}

test("Retry-After beyond the total timeout does not trigger an early retry", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, { error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "5" }));
  assert.equal((await h.run([...prompt, "--timeout-ms", "500"])).code, 1);
  assert.equal(h.requests.length, 1);
});

test("an ambiguous request timeout is not retried", async (t) => {
  const h = await harness(t, () => {});
  const r = await h.run([...prompt, "--timeout-ms", "200"]);
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 1);
  assert.match(r.stderr, /未自动重发/);
});

test("transport failures retain their cause and remain non-retrying", async (t) => {
  const h = await harness(t, (req, res) => res.destroy());
  const r = await h.run(prompt);
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 1);
  assert.match(r.result.errors.join(" "), /UND_ERR_SOCKET|other side closed/);
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.equal(record.attempts, 1);
  assert.equal(record.transport_error.code, "UND_ERR_SOCKET");
  assert.doesNotMatch(JSON.stringify(record), /local-test-key/);
});

test("Sunburst multipart edits keep references and save one output", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const ref = path.join(h.dir, "reference.png");
  await fs.writeFile(ref, Buffer.from(fixtures.png, "base64"));
  const r = await h.run([...prompt, "--model", "sunburst", "--quality", "max", "--image", ref, "--image", ref, "-n", "3"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.images.length, 1);
  const req = h.requests[0];
  assert.equal(req.url, "/images/edits");
  assert.match(req.headers["content-type"], /multipart\/form-data/);
  const body = req.body.toString();
  assert.equal((body.match(/name="image"/g) || []).length, 2);
  assert.ok(body.includes("gpt-image-2.5-sunburst"));
  assert.ok(body.includes("\r\nmax\r\n"));
  assert.ok(!body.includes('name="n"'));
});

test("downloaded bytes determine the suffix without forwarding the API key", async (t) => {
  let baseUrl;
  const h = await harness(t, (req, res) => {
    if (req.method === "GET") {
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(fixtures.jpeg, "base64"));
    } else sendJSON(res, { data: [{ url: `${baseUrl}/misleading.png` }] });
  });
  baseUrl = h.baseUrl;
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(path.extname(r.result.images[0].path), ".jpg");
  assert.equal(h.requests.length, 2);
});

test("parallel local calls respect configured pacing and never overwrite files", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const results = await Promise.all(Array.from({ length: 3 }, () => h.run([...prompt, "--min-interval-ms", "160"])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(new Set(results.map((r) => r.result.images[0].path)).size, 3);
  assert.equal((await fs.readdir(h.outDir)).length, 6);
  for (let i = 1; i < h.requests.length; i += 1) assert.ok(h.requests[i].time - h.requests[i - 1].time >= 100);
});

const infoResponse = { ...imageResponse(), usage: { input_tokens: 7, output_tokens: 12 } };

test("optional info summary includes requested ratio and saved count while preserving usage", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, infoResponse));
  const r = await h.run([...prompt, "--show-info"]);
  assert.equal(r.code, 0, r.stderr);
  const { elapsed_seconds: elapsed, ...summary } = r.result.info_summary;
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0);
  assert.deepEqual(summary, {
    model: "gpt-image-2.5-flare", resolution: "2 × 2", quality: "low",
    aspect_ratio: "1:1", aspect_ratio_source: "requested", image_count: 1, requested_count: 1,
    output_format: "PNG", background: null,
    input_tokens: 7, output_tokens: 12,
  });
  const display = r.stdout.slice(r.stdout.lastIndexOf("模型：")).trim();
  assert.equal(display, `模型：GPT Image 2.5 Flare\n分辨率：2 × 2\n比例：1:1（请求比例）\n图片数量：1 张\n质量：低（low）\n输出格式：PNG\n背景：未指定\n总耗时：${elapsed.toFixed(2)} 秒（含保存）\n输入/输出 token：7 / 12`);
  assert.ok(r.stdout.indexOf("![生成图片 1]") < r.stdout.indexOf("模型："));
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.equal(record.usage.input_tokens, 7);
  assert.equal(record.requested_aspect_ratio, "1:1");
  assert.equal(record.requested_count, 1);
  assert.equal(JSON.parse(h.requests[0].body).requested_aspect_ratio, undefined);
  assert.equal(record.cost, undefined);
  assert.equal(h.requests.length, 1);
});

test("no-info overrides enabled environment and preference defaults", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, infoResponse));
  await preferenceFixture(h, { show_info: true });
  for (const env of [{}, { GPT_IMAGE2_SHOW_INFO: "true" }]) {
    const r = await h.run([...prompt, "--no-info"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.result.info_summary, undefined);
    assert.doesNotMatch(r.stdout, /模型：/);
  }
});

test("enabled environment and preference defaults add info without a CLI flag", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, infoResponse));
  let r = await h.run(prompt, { GPT_IMAGE2_SHOW_INFO: "true" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.info_summary.input_tokens, 7);
  await preferenceFixture(h, { show_info: true });
  r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.info_summary.output_tokens, 12);
});

test("missing token counts remain unknown while zero counts remain zero", async (t) => {
  const h = await harness(t, (_req, res, count) => sendJSON(res, count === 1
    ? imageResponse() : { ...imageResponse(), usage: { input_tokens: 0, output_tokens: 0 } }));
  let r = await h.run([...prompt, "--show-info"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.info_summary.input_tokens, null);
  assert.equal(r.result.info_summary.output_tokens, null);
  assert.match(r.stdout, /输入\/输出 token：未提供 \/ 未提供/);
  r = await h.run([...prompt, "--show-info"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /输入\/输出 token：0 \/ 0/);
});

test("partial output info shows saved count separately from requested count", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run([...prompt, "-n", "2", "--aspect-ratio", "16:9", "--show-info"]);
  assert.equal(r.code, 1);
  assert.equal(r.result.status, "partial");
  assert.equal(r.result.info_summary.image_count, 1);
  assert.equal(r.result.info_summary.requested_count, 2);
  assert.equal(r.result.info_summary.aspect_ratio, "16:9");
  assert.equal(r.result.info_summary.resolution, "2 × 2");
  assert.match(r.stdout, /比例：16:9（请求比例）/);
  assert.match(r.stdout, /图片数量：已保存 1 张 \/ 请求 2 张/);
});

test("older records derive actual ratio and unknown sizes stay unknown", async () => {
  const { buildInfoSummary, formatInfoSummary } = await import("./info-summary.mjs");
  const summary = buildInfoSummary({
    request: { n: 2 }, images: [{ width: 1280, height: 720 }],
  });
  assert.equal(summary.aspect_ratio, "16:9");
  assert.equal(summary.aspect_ratio_source, "actual");
  assert.match(formatInfoSummary(summary), /比例：16:9（实际比例）/);
  const missing = buildInfoSummary({ images: [{ width: 0, height: 720 }] });
  assert.equal(missing.aspect_ratio, null);
  assert.match(formatInfoSummary(missing), /比例：未提供/);
});

test("info uses saved formats, labels requested background and validates total timing", async () => {
  const { buildInfoSummary, formatInfoSummary } = await import("./info-summary.mjs");
  const base = {
    request: { output_format: "jpeg", background: "transparent" },
    images: [{ mime_type: "image/png" }, { mime_type: "image/webp" }],
    elapsed_seconds: 1, timing: { total_seconds: 9.074 },
  };
  const summary = buildInfoSummary(base);
  assert.equal(summary.output_format, "PNG、WebP");
  assert.equal(summary.elapsed_seconds, 9.074);
  assert.match(formatInfoSummary(summary), /背景：透明（请求设置）/);
  assert.match(formatInfoSummary(summary), /总耗时：9\.07 秒（含保存）/);
  for (const time of [undefined, null, -1, NaN, Infinity, "9"]) {
    const invalid = buildInfoSummary({ images: [], timing: { total_seconds: time } });
    assert.equal(invalid.elapsed_seconds, null);
    assert.equal(invalid.output_format, null);
    assert.match(formatInfoSummary(invalid), /总耗时：未提供/);
  }
  assert.equal(buildInfoSummary({ timing: { total_seconds: 0 } }).elapsed_seconds, 0);
});

test("removed billing CLI options fail locally before sending requests", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, infoResponse));
  for (const args of [["--show-cost"], ["--no-cost"], ["--cost-lookup-cli", "unused.mjs"]]) {
    const r = await h.run([...prompt, ...args]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /未知参数/);
  }
  assert.equal(h.requests.length, 0);
});

test("an output path that is a file fails before a paid request", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  await fs.writeFile(h.outDir, "not a directory");
  assert.equal((await h.run(prompt)).code, 1);
  assert.equal(h.requests.length, 0);
});

test("CLI values override invalid environment defaults before validation", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run([...prompt, "--model", "flare", "--quality", "medium", "-n", "1",
    "--resolution", "1k", "--timeout-ms", "5000", "--no-info"], {
    GPT_IMAGE2_MODEL: "broken-model", GPT_IMAGE2_QUALITY: "broken-quality", GPT_IMAGE2_N: "bad",
    GPT_IMAGE2_RESOLUTION: "9k", GPT_IMAGE2_TIMEOUT_MS: "bad", GPT_IMAGE2_SHOW_INFO: "bad",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(h.requests[0].body).quality, "medium");
});

test("help remains usable with invalid configuration", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run(["--help"], { GPT_IMAGE2_MODEL: "invalid", GPT_IMAGE2_N: "invalid" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /用法/);
  assert.equal(h.requests.length, 0);
});

test("dry-run works without a key and does not create output files", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run([...prompt, "--dry-run"], { GPT_IMAGE2_API_KEY: "" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests.length, 0);
  await assert.rejects(fs.access(h.outDir));
});

test("zero compression in the environment overrides the dotenv value", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse("webp")));
  await fs.writeFile(path.join(h.dir, ".env"), "GPT_IMAGE2_OUTPUT_COMPRESSION=80\n");
  const r = await h.run([...prompt, "--output-format", "webp"], { GPT_IMAGE2_OUTPUT_COMPRESSION: "0" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(h.requests[0].body).output_compression, 0);
});

test("blank and placeholder keys are rejected before any request", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const key of ["   ", "你的API密钥", "YOUR_API_KEY", "sk-xxx"]) {
    const r = await h.run(prompt, { GPT_IMAGE2_API_KEY: key });
    assert.equal(r.code, 1);
  }
  assert.equal(h.requests.length, 0);
});

test("empty environment options intentionally clear dotenv defaults", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  await fs.writeFile(path.join(h.dir, ".env"), "GPT_IMAGE2_BACKGROUND=transparent\n");
  const r = await h.run(prompt, { GPT_IMAGE2_BACKGROUND: "" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(h.requests[0].body).background, undefined);
});

test("a fake reference image is rejected before generation", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const ref = path.join(h.dir, "fake.png");
  await fs.writeFile(ref, "not an image");
  assert.equal((await h.run([...prompt, "--image", ref])).code, 1);
  assert.equal(h.requests.length, 0);
});

for (const format of ["png", "jpeg", "webp"]) {
  test(`truncated ${format} is never reported as a successfully saved image`, async (t) => {
    const raw = Buffer.from(fixtures[format], "base64");
    const truncated = raw.subarray(0, format === "png" ? 24 : raw.length - 8);
    const h = await harness(t, (_req, res) => sendJSON(res, { data: [{ b64_json: truncated.toString("base64") }] }));
    const r = await h.run(prompt);
    assert.equal(r.code, 1);
    assert.equal(r.result.images.length, 0);
    assert.equal(r.result.status, "failed");
  });
}

test("quota exhaustion described only in the message is not retried", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, {
    error: { message: "Insufficient balance, please recharge your account" },
  }, 429, { "retry-after": "0" }));
  assert.equal((await h.run(prompt)).code, 1);
  assert.equal(h.requests.length, 1);
});

test("failed generation requests retain a record and never expose the key", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, {
    error: { message: "local-test-key authentication failed" },
  }, 401, { "x-request-id": "failed-request" }));
  const r = await h.run(prompt);
  assert.equal(r.code, 1);
  assert.ok(r.result?.metadata_path);
  const record = await fs.readFile(r.result.metadata_path, "utf8");
  assert.equal(JSON.parse(record).request_id, "failed-request");
  assert.doesNotMatch(record + r.stdout + r.stderr, /local-test-key/);
});

test("registration URLs cannot be mistaken for an API base", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const r = await h.run(prompt, { GPT_IMAGE2_BASE_URL: `${h.baseUrl}/register?aff=test` });
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 0);
});

test("metadata failure does not hide images already saved", async (t) => {
  const h = await harness(t, async (_req, res) => {
    const files = await fs.readdir(h.outDir);
    const pending = files.find((name) => name.endsWith(".json"));
    if (pending) {
      await fs.unlink(path.join(h.outDir, pending));
      await fs.mkdir(path.join(h.outDir, pending));
    }
    sendJSON(res, imageResponse());
  });
  const r = await h.run(prompt);
  assert.ok(r.result?.images.length);
  assert.ok(r.stdout.includes("![生成图片 1]"));
  assert.match(r.stdout, /记录/);
});

test("dotenv accepts export prefixes, quoted values and inline comments", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  await fs.writeFile(path.join(h.dir, ".env"), [
    'export GPT_IMAGE2_MODEL="sunburst" # chosen model',
    "GPT_IMAGE2_QUALITY=medium # default quality",
    "GPT_IMAGE2_N='1' # count",
  ].join("\n"));
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(h.requests[0].body);
  assert.equal(body.model, "gpt-image-2.5-sunburst");
  assert.equal(body.quality, "medium");
});

test("API redirects are rejected without sending a second generation request", async (t) => {
  const h = await harness(t, (_req, res) => {
    res.writeHead(307, { location: "/redirected-generation" });
    res.end();
  });
  assert.equal((await h.run(prompt)).code, 1);
  assert.equal(h.requests.length, 1);
});

test("multiple URL images download concurrently and preserve response ordering", async (t) => {
  let baseUrl, active = 0, peak = 0;
  const h = await harness(t, async (req, res) => {
    if (req.method === "POST") {
      sendJSON(res, { data: [1, 2, 3, 4].map((i) => ({ url: `${baseUrl}/image${i}`, revised_prompt: `image${i}` })) });
      return;
    }
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, req.url === "/image1" ? 140 : 60));
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(fixtures.png, "base64"));
    active -= 1;
  });
  baseUrl = h.baseUrl;
  const r = await h.run([...prompt, "-n", "4"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(peak >= 2 && peak <= 3, `peak concurrent downloads: ${peak}`);
  assert.deepEqual(r.result.images.map((image) => image.revised_prompt), ["image1", "image2", "image3", "image4"]);
  assert.ok(JSON.parse(await fs.readFile(r.result.metadata_path, "utf8")).timing.total_seconds >= 0);
});

test("download timeout preserves completed images without repeating generation", async (t) => {
  let baseUrl;
  const h = await harness(t, (req, res) => {
    if (req.method === "POST") {
      sendJSON(res, { data: [{ b64_json: fixtures.png }, { url: `${baseUrl}/stall` }] });
    }
  });
  baseUrl = h.baseUrl;
  const r = await h.run([...prompt, "-n", "2", "--timeout-ms", "300"]);
  assert.equal(r.code, 1);
  assert.equal(r.result.status, "partial");
  assert.equal(r.result.images.length, 1);
  assert.equal(h.requests.filter((req) => req.method === "POST").length, 1);
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.deepEqual(record.recoverable_images, [{ index: 2, url: `${baseUrl}/stall` }]);
});

test("excess response images are preserved with a count warning", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, { data: [imageResponse().data[0], imageResponse().data[0]] }));
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.images.length, 2);
  assert.ok(r.result.warnings.some((warning) => warning.includes("2")));
});

test("oversized Content-Length is rejected before reading the image body", async (t) => {
  let baseUrl;
  const h = await harness(t, (req, res) => {
    if (req.method === "POST") sendJSON(res, { data: [{ url: `${baseUrl}/huge` }] });
    else {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(200 * 1024 * 1024) });
      res.flushHeaders();
    }
  });
  baseUrl = h.baseUrl;
  const r = await h.run([...prompt, "--timeout-ms", "1000"]);
  assert.equal(r.code, 1);
  assert.ok(r.result.errors.some((error) => /大小|限制/.test(error)));
});

test("secrets echoed in API response metadata are redacted from records and terminal output", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, {
    data: [{ b64_json: fixtures.png, revised_prompt: "echo local-test-key" }],
    usage: { input_tokens: 1, debug: "local-test-key" },
  }));
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr + await fs.readFile(r.result.metadata_path, "utf8"), /local-test-key/);
});

test("corrupt PNG chunk checksums are rejected", async (t) => {
  const damaged = Buffer.from(fixtures.png, "base64");
  damaged[damaged.length - 1] ^= 1;
  const h = await harness(t, (_req, res) => sendJSON(res, { data: [{ b64_json: damaged.toString("base64") }] }));
  assert.equal((await h.run(prompt)).code, 1);
});

test("removed model is rejected from CLI, environment, dotenv, preferences and snapshots before requests", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const rejected = async (args, env = {}) => {
    const r = await h.run([...prompt, ...args], env);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /只能是 gpt-image-2\.5-flare.*gpt-image-2\.5-sunburst/);
  };
  await rejected(["--model", "gpt-image-2"]);
  await rejected([], { GPT_IMAGE2_MODEL: "gpt-image-2" });
  await fs.writeFile(path.join(h.dir, ".env"), "GPT_IMAGE2_MODEL=gpt-image-2\n");
  await rejected([]);
  await fs.unlink(path.join(h.dir, ".env"));
  const config = path.join(h.dir, "execution.json");
  await fs.writeFile(config, JSON.stringify({
    schema_version: 1, request_defaults: { ...taskDefaults, GPT_IMAGE2_MODEL: "gpt-image-2" },
  }));
  await rejected(["--execution-config", config]);
  await preferenceFixture(h, { model: "gpt-image-2" });
  await rejected([]);
  assert.equal(h.requests.length, 0);
});

test("Flare and Sunburst retain highest quality and transparent output", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    const r = await h.run([...prompt, "--model", model, "--quality", "max", "--background", "transparent"]);
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(h.requests.at(-1).body.toString());
    assert.equal(body.model, model);
    assert.equal(body.quality, "max");
    assert.equal(body.background, "transparent");
    assert.equal(body.output_format, "png");
  }
});

test("invalid parameter combinations and unreadable references never call the service", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const args of [
    ["--background", "transparent", "--output-format", "jpeg"],
    ["--output-format", "png", "--output-compression", "50"],
    ["--max-retries", "11"],
    ["--image", path.join(h.dir, "missing.png")],
    ["--image", h.dir],
  ]) assert.equal((await h.run([...prompt, ...args])).code, 1);
  const empty = path.join(h.dir, "empty.png");
  await fs.writeFile(empty, "");
  assert.equal((await h.run([...prompt, "--image", empty])).code, 1);
  const tooLarge = path.join(h.dir, "oversize.png");
  const file = await fs.open(tooLarge, "w");
  await file.truncate(10 * 1024 * 1024 + 1);
  await file.close();
  assert.equal((await h.run([...prompt, "--image", tooLarge])).code, 1);
  assert.equal((await h.run([...prompt, ...Array.from({ length: 17 }, () => ["--image", empty]).flat()])).code, 1);
  assert.equal(h.requests.length, 0);
});

test("all declared resolution and aspect-ratio pairs produce valid aligned sizes without requests", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const ratios = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"];
  for (const resolution of ["1k", "2k", "4k"]) {
    for (const ratio of ratios) {
      const r = await h.run([...prompt, "--dry-run", "--resolution", resolution, "--aspect-ratio", ratio]);
      assert.equal(r.code, 0, `${resolution} ${ratio}: ${r.stderr}`);
      const size = /"size": "(\d+)x(\d+)"/.exec(r.stdout);
      assert.ok(size);
      const [w, height] = size.slice(1).map(Number);
      const [ratioW, ratioH] = ratio.split(":").map(Number);
      assert.equal(w % 16, 0);
      assert.equal(height % 16, 0);
      assert.equal(w * ratioH, height * ratioW);
      assert.ok(w * height >= 655360 && w * height <= 8294400);
    }
  }
  assert.equal(h.requests.length, 0);
});

test("actual model, dimensions and format override assumptions in the summary", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, {
    model: "gpt-image-2.5-sunburst", data: [{ b64_json: fixtures.jpeg }],
  }));
  const r = await h.run([...prompt, "--output-format", "png", "--show-info"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.info_summary.model, "gpt-image-2.5-sunburst");
  assert.equal(r.result.info_summary.resolution, "2 × 2");
  assert.ok(r.result.warnings.some((warning) => warning.includes("模型")));
  assert.ok(r.result.warnings.some((warning) => warning.includes("尺寸")));
  assert.ok(r.result.warnings.some((warning) => warning.includes("格式")));
  assert.equal(path.extname(r.result.images[0].path), ".jpg");
});

test("oversized timer values cannot silently become a one-millisecond timeout", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  assert.equal((await h.run([...prompt, "--timeout-ms", "2147483648"])).code, 1);
  assert.equal(h.requests.length, 0);
});

test("chunked oversized bodies are rejected even without Content-Length", async () => {
  const { readLimitedBody } = await import("./request-controls.mjs");
  let canceled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() { canceled = true; },
  }));
  await assert.rejects(readLimitedBody(response, 10), /限制/);
  assert.equal(canceled, true);
});

test("opaque bodies under the size cap are read without changing bytes", async () => {
  const { readLimitedBody } = await import("./request-controls.mjs");
  const body = Buffer.from([0, 128, 255]);
  assert.deepEqual(await readLimitedBody(new Response(body), 10), body);
});

test("unexpected extra reference-mode images are preserved instead of discarded", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, { data: [imageResponse().data[0], imageResponse().data[0]] }));
  const ref = path.join(h.dir, "reference.png");
  await fs.writeFile(ref, Buffer.from(fixtures.png, "base64"));
  const r = await h.run([...prompt, "--image", ref, "-n", "2"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.images.length, 2);
  assert.ok(r.result.warnings.some((warning) => warning.includes("参考图")));
  assert.ok(r.result.warnings.some((warning) => warning.includes("计费")));
  assert.doesNotMatch(h.requests[0].body.toString(), /name="n"/);
});

test("command-line keys are rejected without echoing the supplied secret", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const args of [["--api-key", "private-cli-key"], ["--api-key=private-cli-key"]]) {
    const r = await h.run([...prompt, ...args]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /private-cli-key/);
  }
  assert.equal(h.requests.length, 0);
});

test("unsupported protocol modes never send requests", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const mode of ["official-compatible", "official", "openai", "openai-compatible"]) {
    assert.equal((await h.run([...prompt, "--mode", mode])).code, 1);
    assert.equal((await h.run(prompt, { GPT_IMAGE2_MODE: mode })).code, 1);
  }
  const config = path.join(h.dir, "execution.json");
  await fs.writeFile(config, JSON.stringify({
    schema_version: 1, request_defaults: { ...taskDefaults, GPT_IMAGE2_MODE: "official-compatible" },
  }));
  assert.equal((await h.run([...prompt, "--execution-config", config])).code, 1);
  assert.equal(h.requests.length, 0);
});

test("count limits apply to CLI, environment, dotenv, preferences and snapshots", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const count of ["0", "5", "999999"]) {
    assert.equal((await h.run([...prompt, "-n", count])).code, 1);
    assert.equal((await h.run(prompt, { GPT_IMAGE2_N: count })).code, 1);
  }
  const legacy = path.join(h.dir, ".env");
  await fs.writeFile(legacy, "GPT_IMAGE2_N=5\n");
  assert.equal((await h.run(prompt)).code, 1);
  await fs.unlink(legacy);
  const config = path.join(h.dir, "execution.json");
  await fs.writeFile(config, JSON.stringify({
    schema_version: 1, request_defaults: { ...taskDefaults, GPT_IMAGE2_N: 5 },
  }));
  assert.equal((await h.run([...prompt, "--execution-config", config])).code, 1);
  await preferenceFixture(h, { n: 5 });
  assert.equal((await h.run(prompt)).code, 1);
  assert.equal(h.requests.length, 0);
});

test("cross-origin delivery cannot reach a second local server or private targets", async (t) => {
  const target = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const urls = [
    `${target.baseUrl}/private`, "http://localhost/private", "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/private", "http://[::1]/private", "https://cdn.example.invalid/image.png",
    "http://2130706433/private", "file:///secret",
  ];
  const h = await harness(t, (_req, res) => sendJSON(res, {
    data: urls.map((url) => ({ url })),
  }));
  const r = await h.run(prompt);
  assert.equal(r.code, 1);
  assert.equal(r.result.images.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(target.requests.length, 0);
});

test("same-origin image redirects are rejected without following the destination", async (t) => {
  let baseUrl;
  const h = await harness(t, (req, res) => {
    if (req.method === "POST") sendJSON(res, { data: [{ url: `${baseUrl}/redirect` }] });
    else { res.writeHead(302, { location: `${baseUrl}/destination` }); res.end(); }
  });
  baseUrl = h.baseUrl;
  const r = await h.run(prompt);
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests.some((req) => req.url === "/destination"), false);
});

test("unsupported reference formats fail locally even when the magic is recognized", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const [extension, raw] of [
    ["gif", Buffer.from("GIF89a" + "\0".repeat(32))],
    ["bmp", Buffer.from("BM" + "\0".repeat(32))],
    ["tiff", Buffer.from([0x49, 0x49, 0x2a, 0, ...new Array(32).fill(0)])],
  ]) {
    const ref = path.join(h.dir, `reference.${extension}`);
    await fs.writeFile(ref, raw);
    assert.equal((await h.run([...prompt, "--image", ref])).code, 1);
  }
  assert.equal(h.requests.length, 0);
});

test("private metadata hides structured paths while results remain previewable", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  const ref = path.join(h.dir, "reference.png");
  await fs.writeFile(ref, Buffer.from(fixtures.png, "base64"));
  for (const [args, env] of [
    [["--private-metadata"], {}],
    [[], { GPT_IMAGE2_PRIVATE_METADATA: "true" }],
  ]) {
    const r = await h.run([...prompt, "--image", ref, ...args], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(path.isAbsolute(r.result.images[0].path));
    const text = await fs.readFile(r.result.metadata_path, "utf8");
    const record = JSON.parse(text);
    assert.equal(record.reference_images[0].path, "reference.png");
    assert.equal(record.images[0].path, path.basename(r.result.images[0].path));
    assert.equal(text.includes(JSON.stringify(h.root).slice(1, -1)), false);
    assert.deepEqual(await fs.readFile(r.result.images[0].path), Buffer.from(fixtures.png, "base64"));
  }
});

test("model discovery is offline and independent of broken or private configuration", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  await preferenceFixture(h, { model: "not-a-model" });
  for (const command of ["models", "--models"]) {
    const r = await h.run([command], { BANANA_API_KEY: "secret-model-key", GPT_IMAGE2_N: "broken" });
    assert.equal(r.code, 0, r.stderr);
    const models = JSON.parse(r.stdout).models;
    assert.deepEqual(models.map((model) => model.alias), ["flare", "sunburst", "banana"]);
    assert.equal(models[2].maxReferences, 14);
    assert.equal(models[2].transparent, false);
    assert.ok(models[2].ratios.includes("1:8"));
    assert.doesNotMatch(r.stdout, /secret-model-key/);
  }
  assert.equal(h.requests.length, 0);
});

test("Banana has independent key readiness, local dotenv and environment precedence", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, bananaResponse()));
  let r = await h.run(bananaPrompt);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BANANA_API_KEY/);
  assert.equal(h.requests.length, 0);
  r = await h.run(["--check-config", "--model", "banana"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).configured, false);
  assert.deepEqual(JSON.parse(r.stdout).providers, { gpt: true, banana: false });
  await fs.writeFile(path.join(h.dir, ".env"), "BANANA_API_KEY=dotenv-banana-key\n");
  r = await h.run(bananaPrompt);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests[0].headers.authorization, "Bearer dotenv-banana-key");
  r = await h.run(bananaPrompt, bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests[1].headers.authorization, "Bearer banana-local-key");
  r = await h.run(["--check-config", "--model", "banana"], { BANANA_API_KEY: "" });
  assert.equal(JSON.parse(r.stdout).configured, false);
  r = await h.run(["check"], bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).providers.banana, true);
  assert.doesNotMatch(r.stdout + r.stderr, /dotenv-banana-key|banana-local-key/);
});

test("Banana reference input uses inlineData and one output with validated bytes", async (t) => {
  const h = await harness(t, (req, res) => {
    const payload = JSON.parse(req.body);
    assert.deepEqual(payload.contents[0].parts[1].inlineData, {
      mimeType: "image/png", data: fixtures.png,
    });
    assert.equal(payload.generationConfig.imageConfig.aspectRatio, "1:4");
    assert.equal(payload.generationConfig.thinkingConfig, undefined);
    sendJSON(res, bananaResponse());
  });
  const ref = path.join(h.dir, "参考图.png");
  await fs.writeFile(ref, Buffer.from(fixtures.png, "base64"));
  const r = await h.run([...bananaPrompt, "--image", ref, "-n", "4",
    "--quality", "high", "--aspect-ratio", "1:4", "--private-metadata"], bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests.length, 1);
  assert.equal(r.result.images.length, 1);
  assert.ok(r.result.warnings.some((warning) => warning.includes("参考图")));
  const text = await fs.readFile(r.result.metadata_path, "utf8");
  assert.doesNotMatch(text, /iVBORw0KGgo/);
  assert.equal(JSON.parse(text).reference_images[0].path, "参考图.png");
});

test("Banana-specific limits and unsupported GPT options stop before requests", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, bananaResponse()));
  for (const args of [
    ["--background", "transparent"], ["--output-format", "webp"],
    ["--output-format", "jpeg"], ["--output-compression", "0"], ["--moderation", "low"],
    ["--aspect-ratio", "2:1"], ["--concurrency", "0"], ["--concurrency", "5"],
    Array.from({ length: 15 }, () => ["--image", "unused.png"]).flat(),
  ]) {
    const r = await h.run([...bananaPrompt, ...args], bananaEnv);
    assert.equal(r.code, 1, JSON.stringify(args));
  }
  const gpt = await h.run([...prompt, "--aspect-ratio", "1:8"]);
  assert.equal(gpt.code, 1);
  assert.equal(h.requests.length, 0);
});

test("Banana dry-run aliases preserve Unicode prompts and never submit or save output", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, bananaResponse()));
  for (const alias of ["banana", "nano-banana", "nano-banana-2.1", "gemini-nano-banana-2.1", "香蕉"]) {
    const r = await h.run(["--model", alias, "--prompt", "春天的海报 🌸", "--dry-run",
      "--aspect-ratio", "8:1", "-n", "3"], { GPT_IMAGE2_API_KEY: "", BANANA_API_KEY: "" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /gemini-nano-banana-2\.1:generateContent/);
    assert.match(r.stdout, /"request_count": 3/);
    assert.match(r.stdout, /春天的海报 🌸/);
  }
  assert.equal(h.requests.length, 0);
  await assert.rejects(fs.access(h.outDir));
});

test("Banana bounded workers save each request and preserve order despite out-of-order responses", async (t) => {
  let active = 0, peak = 0;
  const h = await harness(t, async (_req, res, count) => {
    active++;
    peak = Math.max(peak, active);
    const files = await fs.readdir(h.outDir);
    const record = JSON.parse(await fs.readFile(path.join(h.outDir, files.find((name) => name.endsWith(".json"))), "utf8"));
    assert.equal(record.subrequests[count - 1].status, "pending");
    if (count === 3) assert.ok(files.some((name) => name.endsWith(".png")), "earlier image is already saved");
    await new Promise((resolve) => setTimeout(resolve, count === 1 ? 220 : 40));
    sendJSON(res, bananaResponse({ modelVersion: `banana-result-${count}` }), 200, { "x-request-id": `banana-${count}` });
    active--;
  });
  const r = await h.run([...bananaPrompt, "-n", "4"], bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(peak, 2);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(r.result.images.map((image) => image.model),
    ["banana-result-1", "banana-result-2", "banana-result-3", "banana-result-4"]);
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.deepEqual(record.usage, { input_tokens: 28, output_tokens: 48 });
  assert.deepEqual(record.subrequests.map((item) => item.request_id), ["banana-1", "banana-2", "banana-3", "banana-4"]);
  assert.ok(record.subrequests.every((item) => item.status === "success"));
});

test("Banana single worker respects configured concurrency and retains partial success", async (t) => {
  const h = await harness(t, (_req, res, count) => {
    if (count === 2) sendJSON(res, { error: { message: "provider failure" } }, 500);
    else sendJSON(res, bananaResponse());
  });
  const r = await h.run([...bananaPrompt, "-n", "3", "--concurrency", "1"], bananaEnv);
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 3);
  assert.equal(r.result.status, "partial");
  assert.deepEqual(r.result.images.map((image) => image.request_index), [1, 3]);
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.deepEqual(record.subrequests.map((item) => item.status), ["success", "failed", "success"]);
  assert.deepEqual(record.usage, { input_tokens: null, output_tokens: null });
});

test("Banana shares one generation deadline and does not submit queued requests after timeout", async (t) => {
  const h = await harness(t, (_req, res, count) => {
    if (count === 1) sendJSON(res, bananaResponse());
  });
  const r = await h.run([...bananaPrompt, "-n", "4", "--concurrency", "1", "--timeout-ms", "400"], bananaEnv);
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 2);
  assert.equal(r.result.images.length, 1);
  assert.equal(r.result.status, "partial");
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.deepEqual(record.subrequests.map((item) => item.status), ["success", "failed", "not_sent", "not_sent"]);
});

for (const [label, response] of [
  ["blocked", bananaResponse({ candidates: [], promptFeedback: { blockReason: "SAFETY" } })],
  ["thought only", bananaResponse({ candidates: [{ content: { parts: [
    { thought: true, inlineData: { data: fixtures.png } },
  ] }, finishReason: "NO_IMAGE" }] })],
  ["truncated image", bananaResponse({ candidates: [{ content: { parts: [
    { inlineData: { data: Buffer.from(fixtures.png, "base64").subarray(0, 24).toString("base64") } },
  ] } }] })],
]) {
  test(`Banana ${label} records failure and usage without generating again`, async (t) => {
    const h = await harness(t, (_req, res) => sendJSON(res, response, 200, { "x-request-id": "blocked-id" }));
    const r = await h.run(bananaPrompt, bananaEnv);
    assert.equal(r.code, 1);
    assert.equal(h.requests.length, 1);
    assert.equal(r.result.images.length, 0);
    const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
    assert.equal(record.request_id, "blocked-id");
    assert.deepEqual(record.usage, { input_tokens: 7, output_tokens: 12 });
    assert.equal(record.subrequests[0].status, "failed");
    if (label === "blocked") assert.match(r.result.errors.join(" "), /SAFETY/);
  });
}

test("Banana uses bounded 429 retries and retains exact request metadata", async (t) => {
  const h = await harness(t, (_req, res, count) => {
    if (count === 1) sendJSON(res, { error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "0" });
    else sendJSON(res, bananaResponse(), 200, { "x-request-id": "banana-retried" });
  });
  const r = await h.run(bananaPrompt, bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0].body, h.requests[1].body);
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.equal(record.attempts, 2);
  assert.equal(record.subrequests[0].request_id, "banana-retried");
});

test("Banana execution snapshots use the independent environment key and honor model-specific ratios", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, bananaResponse()));
  const config = path.join(h.dir, "execution.json");
  await fs.writeFile(config, JSON.stringify({ schema_version: 1, request_defaults: {
    ...taskDefaults, GPT_IMAGE2_MODEL: "gemini-nano-banana-2.1", GPT_IMAGE2_ASPECT_RATIO: "4:1",
  } }));
  const r = await h.run([...prompt, "--execution-config", config], bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.requests[0].headers.authorization, "Bearer banana-local-key");
  assert.equal(JSON.parse(h.requests[0].body).generationConfig.imageConfig.aspectRatio, "4:1");
});

test("Banana batch info reports total tokens and provider-specific thinking quality", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, bananaResponse()));
  const r = await h.run([...bananaPrompt, "-n", "2", "--show-info"], bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.info_summary.input_tokens, 14);
  assert.equal(r.result.info_summary.output_tokens, 24);
  assert.equal(r.result.info_summary.quality, "minimal_thinking");
  assert.equal(r.result.info_summary.image_count, 2);
  assert.equal(r.result.info_summary.requested_count, 2);
  assert.match(r.stdout, /最低思考档/);
  assert.equal(h.requests.length, 2);
});

test("Banana chunked encoder preserves bytes across base64 boundaries and enforces its upload cap", async () => {
  const { encodeBananaRequest, MAX_BANANA_REQUEST_BYTES } = await import("./banana-image.mjs");
  const options = { prompt: '中文 "quoted"\n🌸', resolution: "2k", aspectRatio: "1:4", quality: "high" };
  for (const length of [49151, 49152, 49153, 98305]) {
    const raw = Buffer.alloc(length, 233);
    const payload = JSON.parse(encodeBananaRequest(options, [{ mimeType: "image/png", raw }]).toString("utf8"));
    assert.equal(payload.contents[0].parts[0].text, options.prompt);
    assert.deepEqual(Buffer.from(payload.contents[0].parts[1].inlineData.data, "base64"), raw);
    assert.equal(payload.generationConfig.thinkingConfig, undefined);
  }
  const huge = Buffer.alloc(Math.ceil(MAX_BANANA_REQUEST_BYTES * 3 / 4));
  assert.throws(() => encodeBananaRequest(options, [{ mimeType: "image/png", raw: huge }]), /95MB/);
});

test("large Base64 output decodes across chunks and preserves the actual image bytes", async (t) => {
  const jpeg = Buffer.from(fixtures.jpeg, "base64");
  const comment = Buffer.alloc(50000, 97);
  const header = Buffer.from([0xff, 0xfe, 0, 0]);
  header.writeUInt16BE(comment.length + 2, 2);
  const raw = Buffer.concat([jpeg.subarray(0, 2), header, comment, jpeg.subarray(2)]);
  const h = await harness(t, (_req, res) => sendJSON(res, { data: [{ b64_json: raw.toString("base64") }] }));
  const r = await h.run(prompt);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await fs.readFile(r.result.images[0].path), raw);
});

test("Banana metadata failure preserves the saved image and stops all unstarted requests", async (t) => {
  const h = await harness(t, async (_req, res) => {
    const name = (await fs.readdir(h.outDir)).find((file) => file.endsWith(".json"));
    await fs.unlink(path.join(h.outDir, name));
    await fs.mkdir(path.join(h.outDir, name));
    sendJSON(res, bananaResponse());
  });
  const r = await h.run([...bananaPrompt, "-n", "4", "--concurrency", "1"], bananaEnv);
  assert.equal(r.code, 1);
  assert.equal(r.result.status, "partial");
  assert.equal(r.result.images.length, 1);
  assert.equal(r.result.metadata_path, null);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(await fs.readFile(r.result.images[0].path), Buffer.from(fixtures.png, "base64"));
});

test("Banana pacing beyond the deadline is recorded as not sent", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, bananaResponse()));
  const r = await h.run([...bananaPrompt, "-n", "2", "--concurrency", "1",
    "--min-interval-ms", "1000", "--timeout-ms", "500"], bananaEnv);
  assert.equal(r.code, 1);
  assert.equal(h.requests.length, 1);
  const record = JSON.parse(await fs.readFile(r.result.metadata_path, "utf8"));
  assert.equal(record.subrequests[1].status, "not_sent");
  assert.equal(record.subrequests[1].submitted, false);
});

test("Banana unknown token fields never become zero or partial totals", async () => {
  const { parseBananaResponse } = await import("./banana-image.mjs");
  for (const usageMetadata of [
    {}, { promptTokenCount: true, candidatesTokenCount: "10" },
    { promptTokenCount: -1, candidatesTokenCount: 10, thoughtsTokenCount: "2" },
  ]) {
    const response = parseBananaResponse(bananaResponse({ usageMetadata }));
    assert.deepEqual(response.usage, { input_tokens: null, output_tokens: null });
  }
  assert.deepEqual(parseBananaResponse(bananaResponse({
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
  })).usage, { input_tokens: 0, output_tokens: 0 });
});

test("Banana batch info does not report incomplete token totals as complete", async (t) => {
  const h = await harness(t, (_req, res, count) => sendJSON(res,
    count === 1 ? bananaResponse() : bananaResponse({ usageMetadata: {} })));
  const r = await h.run([...bananaPrompt, "-n", "2", "--show-info"], bananaEnv);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.info_summary.input_tokens, null);
  assert.equal(r.result.info_summary.output_tokens, null);
  assert.match(r.stdout, /输入\/输出 token：未提供 \/ 未提供/);
});
