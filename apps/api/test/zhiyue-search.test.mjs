import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { ZodError } from "zod";
import { basicSearch, createZhiyueSearch } from "../dist/zhiyue-search.js";
import { createZhiyueDeviceRouter } from "../dist/zhiyue-http.js";
import { ApiError } from "../dist/errors.js";

const category = { id: "11111111-1111-4111-8111-111111111111", name: "科技", names: ["科学技术"] };
const other = { id: "22222222-2222-4222-8222-222222222222", name: "另一账号私人分类" };
const categories = [category];
const response = (intent) => Response.json({ status: "completed", output: [{ type: "message", content: [
  { type: "output_text", text: JSON.stringify(intent) },
] }] });

test("基础解析覆盖分类历史名称、未分类、文章名及全部文章", () => {
  assert.deepEqual(basicSearch("查看科学技术分类", categories), { kind: "category", q: "", category: category.id });
  assert.equal(basicSearch("查看未分类", categories).category, "uncategorized");
  assert.equal(basicSearch("找文章《第一班电车之前》", categories).q, "第一班电车之前");
  assert.equal(basicSearch("全部文章", categories).kind, "all");
  assert.equal(basicSearch("查看不存在分类", categories).noMatch, true);
  assert.equal(basicSearch("科技分类", [...categories, { ...category, id: other.id }]).noMatch, true);
});

test("OpenAI 只收到识别文本，分类及凭据留在本地，输出映射发布分类历史名称", async () => {
  const resolver = createZhiyueSearch({ apiKey: "synthetic-openai-key", model: "fixture-model", request: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.redirect, "error");
    const payload = JSON.parse(options.body);
    assert.equal(payload.input, "请给我科学技术分类");
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.strict, true);
    assert.ok(!options.body.includes(category.id));
    assert.ok(!options.body.includes(other.name));
    assert.ok(!options.body.includes("synthetic-openai-key"));
    return response({ kind: "category", q: "", categoryName: "科学技术" });
  } });
  const result = await resolver("请给我科学技术分类", categories);
  assert.equal(result.category, category.id);
  assert.equal(result.resolvedBy, "openai");
});

test("语义返回其他账号或不存在的分类时不查询全部文章", async () => {
  const resolver = createZhiyueSearch({ apiKey: "fixture", model: "fixture", request: async () =>
    response({ kind: "category", q: "", categoryName: other.name }) });
  const result = await resolver("某个分类", categories);
  assert.equal(result.noMatch, true);
  assert.equal(result.category, "");
});

test("模型拒答、不完整、错误 JSON、空查询、无依据全量查询和网络失败回退基础检索", async () => {
  for (const request of [
    async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }),
    async () => Response.json({ status: "incomplete" }),
    async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "invalid" }] }] }),
    async () => response({ kind: "article", q: "", categoryName: "" }),
    async () => response({ kind: "all", q: "", categoryName: "" }),
    async () => { throw new Error("network"); },
  ]) {
    const resolver = createZhiyueSearch({ apiKey: "fixture", model: "fixture", request });
    const result = await resolver("查找文章星空", categories);
    assert.equal(result.q, "星空");
    assert.equal(result.resolvedBy, "fallback");
  }
});

test("响应体永久等待也在独立截止时间回退并取消请求", async () => {
  let signal;
  const resolver = createZhiyueSearch({ apiKey: "fixture", model: "fixture", timeoutMs: 10,
    request: async (_url, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; } });
  assert.equal((await resolver("查找星空", [])).resolvedBy, "fallback");
  assert.equal(signal.aborted, true);
});

test("无密钥不发出第三方请求", async () => {
  const resolver = createZhiyueSearch({ request: () => assert.fail("禁止真实网络") });
  assert.equal((await resolver("科技分类", categories)).resolvedBy, "local");
});

async function fixture(t, resolver = createZhiyueSearch()) {
  let revoked = false;
  const reads = [], categoryReads = [];
  const tokenA = "a".repeat(32), tokenB = "b".repeat(32);
  const devices = { async identify(token) {
    if (revoked || ![tokenA, tokenB].includes(token)) throw new ApiError(401, "UNAUTHENTICATED");
    return { accountId: token === tokenA ? "a" : "b", id: token };
  } };
  const cms = {
    async readCategories(identity) {
      categoryReads.push(identity.owner);
      return { categories: identity.owner === "a" ? categories : [other] };
    },
    async readArticles(identity, query) {
      reads.push({ identity, query });
      return { items: [{ articleId: identity.owner, title: "当前发布", createdAt: "2026-11-15", audio: null,
        cms: { category: identity.owner === "a" ? category : other } }], total: 1,
        limit: query.limit, offset: query.offset, navigation: {} };
    },
  };
  const app = express();
  app.use("/v1/zhiyue", createZhiyueDeviceRouter(devices, cms, "https://cms.example.test", () => true, resolver));
  app.use((error, _req, res, _next) => res.status(error instanceof ZodError ? 400 : error.status ?? 500).json({ code: error.code ?? "BAD_REQUEST" }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const call = (path, { token = tokenA, text, method = text === undefined ? "GET" : "POST" } = {}) =>
    fetch("http://127.0.0.1:" + server.address().port + "/v1/zhiyue" + path, {
      method, headers: { Authorization: "Bearer " + token, ...(text === undefined ? {} : { "Content-Type": "application/json" }) },
      body: text === undefined ? undefined : JSON.stringify({ text }),
    });
  return { call, reads, categoryReads, tokenB, revoke() { revoked = true; } };
}

test("HTTP 检索使用设备账号的发布分类，分页复用筛选并返回快照分类", async (t) => {
  const f = await fixture(t);
  const result = await f.call("/read/search", { text: "科技分类" });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "category");
  assert.equal(body.filters.category, category.id);
  assert.equal(body.items[0].category.name, "科技");
  assert.equal(body.items[0].id, "a");
  assert.deepEqual(f.categoryReads, ["a"]);
  assert.equal(f.reads[0].identity.owner, "a");
  assert.equal(f.reads[0].query.category, category.id);
  const next = await f.call("/read/articles?limit=12&offset=12&q=星空&category=" + category.id);
  assert.equal(next.status, 200);
  assert.equal(f.reads.at(-1).query.offset, 12);
  assert.equal(f.reads.at(-1).query.q, "星空");
  const second = await f.call("/read/search", { token: f.tokenB, text: "科技分类" });
  assert.equal((await second.json()).total, 0);
  assert.equal(f.reads.length, 2);
});

test("未授权及无效输入不会调用语义服务或读取内容", async (t) => {
  const f = await fixture(t, () => assert.fail("禁止语义调用"));
  assert.equal((await f.call("/read/search", { token: "wrong", text: "科技" })).status, 401);
  assert.equal((await f.call("/read/search", { text: " ".repeat(201) })).status, 400);
  assert.equal((await f.call("/read/search", { text: "文".repeat(201) })).status, 400);
  assert.equal(f.reads.length, 0);
  assert.equal(f.categoryReads.length, 0);
});

test("语义处理中撤销授权后不返回文章", async (t) => {
  let f;
  f = await fixture(t, async () => {
    f.revoke();
    return { kind: "article", q: "星空", category: "", resolvedBy: "openai" };
  });
  assert.equal((await f.call("/read/search", { text: "找星空" })).status, 401);
  assert.equal(f.reads.length, 0);
});
