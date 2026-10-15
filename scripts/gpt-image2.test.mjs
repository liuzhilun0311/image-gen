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

async function harness(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image2-test-"));
  const outDir = path.join(dir, "images with spaces");
  // Copy executable code only: tests never read a user's .env or use real keys.
  for (const name of ["gpt-image2.mjs", "request-controls.mjs", "cost-summary.mjs", "image-info.mjs"]) {
    await fs.copyFile(path.join(scriptsDir, name), path.join(dir, name));
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
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GPT_IMAGE2_")));
    const child = spawn(process.execPath, [path.join(dir, "gpt-image2.mjs"), ...args], {
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
  return { dir, outDir, baseUrl, requests, run };
}

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

const billedResponse = { ...imageResponse(), usage: { input_tokens: 7, output_tokens: 12 } };
const billedRow = {
  id: 123, request_id: "client:billing-test", model: "gpt-image-2.5-flare",
  input_tokens: 7, output_tokens: 12, actual_cost: 0.07764,
  rate_multiplier: 12, total_cost: 0.00647, api_key: { key: "local-test-key" },
};

async function addBillingFixture(h, rows, target = h.baseUrl) {
  const root = path.join(h.dir, "billing");
  const cli = path.join(root, "scripts", "billing.cjs");
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.writeFile(path.join(root, ".env"), `HEIHUZI_ADMIN_BASE_URL=${target}\n`);
  await fs.writeFile(path.join(root, "rows.json"), JSON.stringify(rows));
  await fs.writeFile(cli, `
const fs = require('node:fs');
const path = require('node:path');
const [command, method, route] = process.argv.slice(2);
if (command !== 'api' || method !== 'GET' || !route.startsWith('/admin/usage?')) process.exit(2);
fs.appendFileSync(path.join(__dirname, '../calls.txt'), route + '\\n');
console.log(JSON.stringify({items: JSON.parse(fs.readFileSync(path.join(__dirname, '../rows.json'), 'utf8'))}));
`);
  return { cli, calls: path.join(root, "calls.txt") };
}

test("optional cost summary uses the precise billing ID and excludes pricing internals", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, billedResponse, 200, {
    "x-request-id": "gateway-id, upstream-id", "x-client-request-id": "billing-test",
  }));
  const billing = await addBillingFixture(h, [billedRow]);
  const r = await h.run([...prompt, "--show-cost", "--cost-lookup-cli", billing.cli]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.cost_summary.generation_cost.amount, 0.07764);
  assert.equal(r.result.cost_summary.generation_cost.status, "confirmed");
  const recordText = await fs.readFile(r.result.metadata_path, "utf8");
  assert.equal(JSON.parse(recordText).client_request_id, "billing-test");
  assert.match(await fs.readFile(billing.calls, "utf8"), /request_id=client%3Abilling-test/);
  const display = r.stdout.slice(r.stdout.lastIndexOf("模型：")).trim();
  assert.equal(display, "模型：GPT Image 2.5 Flare\n分辨率：2 × 2\n质量：低（low）\n输入/输出 token：7 / 12\n生图费用：$0.07764");
  assert.ok(r.stdout.indexOf("![生成图片 1]") < r.stdout.indexOf("模型："));
  for (const text of [r.stdout, recordText]) {
    assert.doesNotMatch(text, /rate_multiplier|total_cost|0\.00647|local-test-key|倍率/);
  }
});

test("no-cost overrides an enabled default and does not query billing", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, billedResponse, 200, { "x-client-request-id": "billing-test" }));
  const billing = await addBillingFixture(h, [billedRow]);
  const r = await h.run([...prompt, "--no-cost", "--cost-lookup-cli", billing.cli], { GPT_IMAGE2_SHOW_COST: "true" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.cost_summary, undefined);
  assert.doesNotMatch(r.stdout, /生图费用/);
  await assert.rejects(fs.access(billing.calls));
});

test("an enabled configuration adds the summary without a CLI flag", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, billedResponse, 200, { "x-client-request-id": "billing-test" }));
  const billing = await addBillingFixture(h, [{ ...billedRow, actual_cost: 0 }]);
  const r = await h.run([...prompt, "--cost-lookup-cli", billing.cli], { GPT_IMAGE2_SHOW_COST: "true" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.cost_summary.generation_cost.amount, 0);
  assert.match(r.stdout, /生图费用：\$0\.00/);
});

for (const [label, rows] of [
  ["wrong key", [{ ...billedRow, api_key: { key: "different-key" } }]],
  ["wrong model", [{ ...billedRow, model: "gpt-image-2" }]],
  ["wrong tokens", [{ ...billedRow, output_tokens: 99 }]],
  ["missing actual cost", [{ ...billedRow, actual_cost: null }]],
  ["negative actual cost", [{ ...billedRow, actual_cost: -1 }]],
  ["ambiguous records", [billedRow, billedRow]],
  ["pending billing", []],
]) {
  test(`${label}: keep the image and never report an unverified amount`, async (t) => {
    const h = await harness(t, (_req, res) => sendJSON(res, billedResponse, 200, { "x-client-request-id": "billing-test" }));
    const billing = await addBillingFixture(h, rows);
    const r = await h.run([...prompt, "--show-cost", "--cost-lookup-cli", billing.cli]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.result.images.length, 1);
    assert.equal(r.result.cost_summary.generation_cost.amount, null);
    assert.match(r.stdout, /生图费用：暂未查到/);
    assert.doesNotMatch(r.stdout, /生图费用：\$/);
  });
}

test("billing on a different service is never queried", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, billedResponse, 200, { "x-client-request-id": "billing-test" }));
  const billing = await addBillingFixture(h, [billedRow], "https://different.invalid");
  const r = await h.run([...prompt, "--show-cost", "--cost-lookup-cli", billing.cli]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.cost_summary.generation_cost.amount, null);
  await assert.rejects(fs.access(billing.calls));
});

test("missing billing access preserves successful image generation", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, billedResponse, 200, { "x-client-request-id": "billing-test" }));
  const r = await h.run([...prompt, "--show-cost", "--cost-lookup-cli", path.join(h.dir, "missing.cjs")]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.status, "success");
  assert.match(r.stdout, /生图费用：暂未查到/);
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
    "--resolution", "1k", "--timeout-ms", "5000", "--no-cost"], {
    GPT_IMAGE2_MODEL: "broken-model", GPT_IMAGE2_QUALITY: "broken-quality", GPT_IMAGE2_N: "bad",
    GPT_IMAGE2_RESOLUTION: "9k", GPT_IMAGE2_TIMEOUT_MS: "bad", GPT_IMAGE2_SHOW_COST: "bad",
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

test("invalid parameter combinations and unreadable references never call the service", async (t) => {
  const h = await harness(t, (_req, res) => sendJSON(res, imageResponse()));
  for (const args of [
    ["--model", "gpt-image-2", "--quality", "max"],
    ["--model", "gpt-image-2", "--background", "transparent"],
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
  const r = await h.run([...prompt, "--output-format", "png", "--show-cost"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.result.cost_summary.model, "gpt-image-2.5-sunburst");
  assert.equal(r.result.cost_summary.resolution, "2 × 2");
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
