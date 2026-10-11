import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  handleBlogRequest,
  readableMarkdown,
  relativeAsset,
} from "../server/blog-api.mjs";

const database = new DatabaseSync(":memory:");
database.exec(
  readFileSync(new URL("../migrations/0001_blog.sql", import.meta.url), "utf8")
);
const DB = {
  async batch(statements) {
    database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
  prepare(sql) {
    let params = [];
    return {
      async all() {
        return { results: database.prepare(sql).all(...params) };
      },
      bind(...values) {
        params = values;
        return this;
      },
      async first() {
        return database.prepare(sql).get(...params) || null;
      },
      async run() {
        return database.prepare(sql).run(...params);
      },
    };
  },
};
const origin = "http://localhost:8788";
const env = {
  APP_ORIGIN: origin,
  BLOG_DB: DB,
  BLOG_SECRET: "test-only-secret-at-least-32-characters",
  MS_CLIENT_ID: "test-client",
  MS_CLIENT_SECRET: "test-secret",
  OWNER_EMAIL: "owner@example.com",
};
let body =
  "# 分享笔记\n\n![图片](photo.png)\n\n[配置](.obsidian/settings.json)";
let microsoftOwner = "owner-id";
const fixture = {
  asset: {
    file: { mimeType: "image/png" },
    id: "asset",
    name: "photo.png",
    parentReference: { id: "vault" },
    size: 20,
  },
  hidden: {
    folder: {},
    id: "hidden",
    name: ".obsidian",
    parentReference: { id: "vault" },
  },
  note: {
    file: {},
    id: "note",
    name: "分享笔记.md",
    parentReference: { id: "vault" },
    size: 100,
  },
  other: {
    file: {},
    id: "other",
    name: "私密笔记.md",
    parentReference: { id: "root" },
    size: 100,
  },
  root: { folder: {}, id: "root", name: "OneDrive" },
  vault: {
    folder: {},
    id: "vault",
    name: "测试笔记库",
    parentReference: { id: "root" },
  },
};
const actualFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.hostname === "login.microsoftonline.com") {
    return Response.json({
      access_token: "PRIVATE_ACCESS_TOKEN",
      expires_in: 3600,
      refresh_token: "PRIVATE_REFRESH_TOKEN",
    });
  }
  if (url.hostname === "download.example.com") {
    assert.ok(!options?.headers?.Authorization);
    return new Response(url.pathname === "/note" ? body : "image-bytes");
  }
  assert.equal(url.hostname, "graph.microsoft.com");
  assert.ok(options.headers.Authorization.startsWith("Bearer "));
  const path = decodeURIComponent(url.pathname);
  if (path === "/v1.0/me") {
    return Response.json({
      displayName: "测试主人",
      id: microsoftOwner,
      mail: "owner@example.com",
    });
  }
  if (path.endsWith("/children")) {
    return Response.json({ value: [fixture.note, fixture.hidden] });
  }
  if (path.endsWith("/content")) {
    return new Response(null, {
      headers: {
        Location: `https://download.example.com/${path.includes("/note/") ? "note" : "asset"}`,
      },
      status: 302,
    });
  }
  if (path.includes(":/photo.png")) {
    return Response.json(fixture.asset);
  }
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
      body: data ? JSON.stringify(data) : undefined,
      headers: {
        ...(session ? { Cookie: session } : {}),
        ...(data
          ? { "Content-Type": "application/json", Origin: originHeader }
          : {}),
      },
      method,
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
    cookie: `blog_session=${finish.headers.get("Set-Cookie")?.match(/blog_session=([^;]+)/)?.[1]}`,
    finish,
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
        { assetIds: ["hidden"], id: "note" },
        session
      )
    ).status,
    400
  );
  const published = await (
    await call("shares", "POST", { assetIds: [], id: "note" }, session)
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
    await call("shares", "POST", { assetIds: ["asset"], id: "note" }, session)
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
