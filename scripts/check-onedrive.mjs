import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  handleBlogRequest,
  relativeAsset,
  readableMarkdown,
} from "../server/blog-api.mjs";
const database = new DatabaseSync(":memory:");
database.exec(
  readFileSync(new URL("../migrations/0001_blog.sql", import.meta.url), "utf8")
);
const DB = {
  prepare(sql) {
    let params = [];
    return {
      bind(...values) {
        params = values;
        return this;
      },
      async first() {
        return database.prepare(sql).get(...params) || null;
      },
      async all() {
        return { results: database.prepare(sql).all(...params) };
      },
      async run() {
        return database.prepare(sql).run(...params);
      },
    };
  },
  async batch(statements) {
    database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
};
const origin = "http://localhost:8788";
const env = {
  BLOG_DB: DB,
  MS_CLIENT_ID: "test-client",
  MS_CLIENT_SECRET: "test-secret",
  BLOG_SECRET: "test-only-secret-at-least-32-characters",
  OWNER_EMAIL: "owner@example.com",
  APP_ORIGIN: origin,
};
let body =
  "# 分享笔记\n\n![图片](photo.png)\n\n[配置](.obsidian/settings.json)";
let microsoftOwner = "owner-id";
const fixture = {
  root: { id: "root", name: "OneDrive", folder: {} },
  vault: {
    id: "vault",
    name: "测试笔记库",
    folder: {},
    parentReference: { id: "root" },
  },
  note: {
    id: "note",
    name: "分享笔记.md",
    size: 100,
    file: {},
    parentReference: { id: "vault" },
  },
  other: {
    id: "other",
    name: "私密笔记.md",
    size: 100,
    file: {},
    parentReference: { id: "root" },
  },
  asset: {
    id: "asset",
    name: "photo.png",
    size: 20,
    file: { mimeType: "image/png" },
    parentReference: { id: "vault" },
  },
  hidden: {
    id: "hidden",
    name: ".obsidian",
    folder: {},
    parentReference: { id: "vault" },
  },
};
const actualFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.hostname === "login.microsoftonline.com")
    return Response.json({
      access_token: "PRIVATE_ACCESS_TOKEN",
      refresh_token: "PRIVATE_REFRESH_TOKEN",
      expires_in: 3600,
    });
  if (url.hostname === "download.example.com") {
    assert.ok(!options?.headers?.Authorization);
    return new Response(url.pathname === "/note" ? body : "image-bytes");
  }
  assert.equal(url.hostname, "graph.microsoft.com");
  assert.ok(options.headers.Authorization.startsWith("Bearer "));
  const path = decodeURIComponent(url.pathname);
  if (path === "/v1.0/me")
    return Response.json({
      id: microsoftOwner,
      mail: "owner@example.com",
      displayName: "测试主人",
    });
  if (path.endsWith("/children"))
    return Response.json({ value: [fixture.note, fixture.hidden] });
  if (path.endsWith("/content"))
    return new Response(null, {
      status: 302,
      headers: {
        Location: `https://download.example.com/${path.includes("/note/") ? "note" : "asset"}`,
      },
    });
  if (path.includes(":/photo.png")) return Response.json(fixture.asset);
  const id = path.split("/").at(-1);
  return fixture[id]
    ? Response.json(fixture[id])
    : new Response(null, { status: 404 });
};
const call = (
  path,
  method = "GET",
  data,
  session = "",
  originHeader = origin
) =>
  handleBlogRequest(
    new Request(`${origin}/api/blog/${path}`, {
      method,
      headers: {
        ...(session ? { Cookie: session } : {}),
        ...(data
          ? { Origin: originHeader, "Content-Type": "application/json" }
          : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
    env
  );
async function login() {
  const start = await call("auth/start");
  const state = new URL(start.headers.get("Location")).searchParams.get(
    "state"
  );
  const cookie = start.headers.get("Set-Cookie").split(";")[0];
  const finish = await call(
    `auth/callback?state=${encodeURIComponent(state)}&code=test-code`,
    "GET",
    undefined,
    cookie
  );
  return {
    finish,
    cookie: `blog_session=${finish.headers.get("Set-Cookie")?.match(/blog_session=([^;]+)/)?.[1]}`,
  };
}
try {
  const loginResult = await login();
  assert.equal(loginResult.finish.status, 302);
  const session = loginResult.cookie;
  assert.ok(
    !database
      .prepare("SELECT tokens FROM connection")
      .get()
      .tokens.includes("PRIVATE")
  );
  assert.equal((await call("folders")).status, 401);
  assert.equal(
    (
      await call(
        "root",
        "PUT",
        { id: "vault" },
        session,
        "https://attacker.example"
      )
    ).status,
    403
  );
  assert.equal(
    (await call("root", "PUT", { id: "vault" }, session)).status,
    200
  );
  assert.equal(
    (await call("preview?item=other", "GET", undefined, session)).status,
    403
  );
  const preview = await (
    await call("preview?item=note", "GET", undefined, session)
  ).json();
  assert.deepEqual(
    preview.assets.map((asset) => asset.id),
    ["asset"]
  );
  assert.equal(
    (
      await call(
        "shares",
        "POST",
        { id: "note", assetIds: ["hidden"] },
        session
      )
    ).status,
    400
  );
  const published = await (
    await call("shares", "POST", { id: "note", assetIds: [] }, session)
  ).json();
  const publicNote = await (await call(`public/${published.slug}`)).json();
  assert.equal(publicNote.markdown, body);
  assert.deepEqual(publicNote.assets, []);
  assert.ok(!JSON.stringify(publicNote).includes("PRIVATE_ACCESS_TOKEN"));
  assert.equal((await call(`media/${published.slug}/asset`)).status, 404);
  body = "# OneDrive 更新后的正文";
  assert.equal(
    (await (await call(`public/${published.slug}`)).json()).markdown,
    body
  );
  assert.equal(
    (await call("shares", "DELETE", { id: "note" }, session)).status,
    200
  );
  assert.equal((await call(`public/${published.slug}`)).status, 404);
  body = "![图片](photo.png)";
  const republished = await (
    await call("shares", "POST", { id: "note", assetIds: ["asset"] }, session)
  ).json();
  assert.equal(republished.slug, published.slug);
  assert.equal(
    await (await call(`media/${published.slug}/asset`)).text(),
    "image-bytes"
  );
  microsoftOwner = "different-owner";
  assert.equal((await login()).finish.status, 403);
  assert.equal(
    database.prepare("SELECT owner_id FROM connection").get().owner_id,
    "owner-id"
  );
  assert.equal(relativeAsset("folder/note.md", "../../secret.png"), null);
  assert.equal(relativeAsset("note.md", ".obsidian/a.json"), null);
  assert.equal(relativeAsset("folder/note.md", "../photo.png"), "photo.png");
  assert.equal(readableMarkdown("---\ntitle: test\n---\n正文"), "正文");
  console.log(
    "OneDrive 接口检查通过：主人核验、跨站拒绝、笔记范围、附件白名单、公开阅读、实时读取、取消分享与固定链接。"
  );
} finally {
  globalThis.fetch = actualFetch;
  database.close();
}
