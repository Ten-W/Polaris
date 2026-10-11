import { marked } from "marked";
const graphOrigin = "https://graph.microsoft.com/v1.0";
const scopes = "User.Read Files.Read offline_access";
const maxNoteBytes = 2 * 1024 * 1024;
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const enc = new TextEncoder();
const base64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const unbase64 = (value) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0)
  );
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (value) =>
  base64(await crypto.subtle.digest("SHA-256", enc.encode(value)));
const cookieValue = (request, name) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const cookie = (env, name, value, age) =>
  `${name}=${value}; HttpOnly; SameSite=Lax; Path=/api/blog; Max-Age=${age}${env.APP_ORIGIN.startsWith("https:") ? "; Secure" : ""}`;
const itemPath = (id) => `/me/drive/items/${encodeURIComponent(id)}`;
const fields = "id,name,size,folder,file,parentReference,lastModifiedDateTime";

async function seal(env, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", enc.encode(env.BLOG_SECRET)),
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${base64(iv)}.${base64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value))))}`;
}
async function open(env, value) {
  const [iv, data] = value.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", enc.encode(env.BLOG_SECRET)),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unbase64(iv) },
        key,
        unbase64(data)
      )
    )
  );
}
async function exchange(env, values) {
  const response = await fetch(
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope: scopes,
        ...values,
      }),
    }
  );
  if (!response.ok)
    fail(401, "微软授权已失效或尚未完成，请重新连接 OneDrive。");
  const tokens = await response.json();
  if (!tokens.access_token || !tokens.refresh_token)
    fail(401, "微软未返回持续读取所需的授权，请重新连接。");
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + tokens.expires_in * 1000,
  };
}
async function connection(env) {
  return env.BLOG_DB.prepare("SELECT * FROM connection WHERE id=1").first();
}
async function accessToken(env, row) {
  if (!row) fail(503, "网站主人尚未连接 OneDrive。");
  let tokens = await open(env, row.tokens);
  if (tokens.expires < Date.now() + 60000) {
    tokens = await exchange(env, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
    });
    // ponytail: conditional update avoids replacing a newer refresh token; use a serialized actor if refresh contention grows.
    await env.BLOG_DB.prepare(
      "UPDATE connection SET tokens=? WHERE id=1 AND tokens=?"
    )
      .bind(await seal(env, tokens), row.tokens)
      .run();
  }
  return tokens.access;
}
async function graph(env, row, path) {
  const response = await fetch(`${graphOrigin}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken(env, row)}` },
  });
  if (!response.ok)
    fail(
      response.status === 404 ? 404 : 502,
      response.status === 404
        ? "OneDrive 文件不存在。"
        : "OneDrive 暂时无法读取，请稍后重试或重新连接。"
    );
  return response.json();
}
async function owner(request, env, row) {
  const session = cookieValue(request, "blog_session");
  if (!session || !row) fail(401, "请用网站主人的微软账号登录。");
  const stored = await env.BLOG_DB.prepare(
    "SELECT owner_id FROM sessions WHERE hash=? AND expires>?"
  )
    .bind(await hash(session), Date.now())
    .first();
  if (!stored || stored.owner_id !== row.owner_id)
    fail(401, "登录已过期，请重新登录。");
}
async function contents(env, row, item) {
  if (item.size > maxNoteBytes || !item.name.toLowerCase().endsWith(".md"))
    fail(400, "请选择小于 2 MB 的 Markdown 笔记。");
  const response = await fetch(`${graphOrigin}${itemPath(item.id)}/content`, {
    headers: { Authorization: `Bearer ${await accessToken(env, row)}` },
    redirect: "manual",
  });
  let download = response;
  if (response.status === 302) {
    const location = response.headers.get("Location");
    if (!location || new URL(location).protocol !== "https:")
      fail(502, "OneDrive 下载地址无效。");
    download = await fetch(location); // Never expose temporary download URLs or send the bearer token to the download host.
  }
  if (!download.ok) fail(502, "笔记内容读取失败。");
  const buffer = await download.arrayBuffer();
  if (buffer.byteLength > maxNoteBytes) fail(400, "笔记超过 2 MB。");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(400, "笔记不是可读取的 UTF-8 Markdown，可能已加密。");
  }
}

export function relativeAsset(notePath, ref) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(ref)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(ref.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\\") || /[\x00-\x1f]/.test(decoded))
    return null;
  const parts = notePath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") {
      if (part.startsWith(".")) return null;
      parts.push(part);
    }
  }
  return parts.join("/");
}
export function readableMarkdown(body) {
  return body
    .replace(/^\uFEFF/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}
async function insideVault(env, row, id) {
  if (!row.vault_id) fail(409, "请先选择笔记库文件夹。");
  const parts = [];
  let current = id;
  for (let depth = 0; depth < 64; depth++) {
    if (current === row.vault_id) return parts.reverse().join("/");
    const item = await graph(
      env,
      row,
      `${itemPath(current)}?$select=${fields}`
    );
    if (!item.name || item.name.startsWith("."))
      fail(403, "不允许分享隐藏文件或配置目录。");
    parts.push(item.name);
    current = item.parentReference?.id;
    if (!current) break;
  }
  fail(403, "只能分享所选笔记库里的文件。");
}
async function preview(env, row, id) {
  const path = await insideVault(env, row, id);
  const item = await graph(env, row, `${itemPath(id)}?$select=${fields}`);
  const markdown = readableMarkdown(await contents(env, row, item));
  const refs = new Set();
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (
      (token.type === "image" || token.type === "link") &&
      relativeAsset(path, token.href) &&
      !/\.md(?:[?#]|$)/i.test(token.href)
    )
      refs.add(token.href);
  });
  if (refs.size > 30) fail(400, "这篇笔记引用超过 30 个附件，请先拆分文章。");
  const assets = [];
  const missing = [];
  for (const ref of refs) {
    const relative = relativeAsset(path, ref);
    try {
      const asset = await graph(
        env,
        row,
        `${itemPath(row.vault_id)}:/${relative.split("/").map(encodeURIComponent).join("/")}?$select=${fields}`
      );
      if (
        asset.folder ||
        asset.size > 20 * 1024 * 1024 ||
        asset.name.toLowerCase().endsWith(".md")
      ) {
        missing.push(ref);
        continue;
      }
      assets.push({ id: asset.id, ref, name: asset.name, size: asset.size });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) missing.push(ref);
      else throw error;
    }
  }
  return {
    id,
    title: item.name.replace(/\.md$/i, ""),
    markdown,
    assets,
    missing,
    modified: item.lastModifiedDateTime,
  };
}
function sameOrigin(request, env) {
  if (
    request.headers.get("Origin") !== env.APP_ORIGIN ||
    request.headers.get("Content-Type")?.split(";")[0] !== "application/json"
  )
    fail(403, "不允许跨站提交。");
}
async function payload(request) {
  if (Number(request.headers.get("Content-Length")) > 10000)
    fail(413, "提交内容过大。");
  const text = await request.text();
  if (text.length > 10000) fail(413, "提交内容过大。");
  try {
    return JSON.parse(text);
  } catch {
    fail(400, "提交格式无效。");
  }
}
export async function handleBlogRequest(request, env) {
  try {
    return await route(request, env);
  } catch (error) {
    return json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : "连接暂时不可用，请稍后再试。",
      },
      error instanceof HttpError ? error.status : 500
    );
  }
}
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/blog\/?/, "").replace(/\/$/, "");
  const configured = Boolean(
    env.BLOG_DB &&
      env.MS_CLIENT_ID &&
      env.MS_CLIENT_SECRET &&
      env.BLOG_SECRET?.length >= 32 &&
      env.APP_ORIGIN &&
      env.OWNER_EMAIL
  );
  if (path === "status" && !configured)
    return json({ configured: false, connected: false, authenticated: false });
  if (!configured) fail(503, "OneDrive 连接配置尚未完成。");
  const row = await connection(env);
  if (path === "status" && request.method === "GET") {
    let authenticated = false;
    try {
      await owner(request, env, row);
      authenticated = true;
    } catch {}
    return json({
      configured: true,
      connected: Boolean(row),
      authenticated,
      name: authenticated ? row.display_name : undefined,
      vaultId: authenticated ? row.vault_id : undefined,
    });
  }
  if (path === "auth/start" && request.method === "GET") {
    const state = random();
    const verifier = random();
    const authorize = new URL(
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"
    );
    authorize.search = new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      response_type: "code",
      redirect_uri: `${env.APP_ORIGIN}/api/blog/auth/callback`,
      scope: scopes,
      state,
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorize.href,
        "Set-Cookie": cookie(
          env,
          "blog_oauth",
          await seal(env, { state, verifier, expires: Date.now() + 600000 }),
          600
        ),
        "Cache-Control": "no-store",
      },
    });
  }
  if (path === "auth/callback" && request.method === "GET") {
    if (url.searchParams.has("error"))
      fail(401, "微软授权未完成，请返回管理页重新连接。");
    let pending;
    try {
      pending = await open(env, cookieValue(request, "blog_oauth") || "");
    } catch {
      fail(401, "登录状态无效，请重新连接。");
    }
    if (
      pending.expires < Date.now() ||
      pending.state !== url.searchParams.get("state") ||
      !url.searchParams.get("code")
    )
      fail(401, "登录验证失败，请重新连接。");
    const tokens = await exchange(env, {
      grant_type: "authorization_code",
      code: url.searchParams.get("code"),
      redirect_uri: `${env.APP_ORIGIN}/api/blog/auth/callback`,
      code_verifier: pending.verifier,
    });
    const meResponse = await fetch(
      `${graphOrigin}/me?$select=id,displayName,mail,userPrincipalName`,
      { headers: { Authorization: `Bearer ${tokens.access}` } }
    );
    if (!meResponse.ok) fail(401, "无法核实微软账号身份。");
    const me = await meResponse.json();
    if (
      !me.id ||
      (row
        ? me.id !== row.owner_id
        : ![me.mail, me.userPrincipalName].some(
            (email) => email?.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
          ))
    )
      fail(403, "这个微软账号不是网站主人。");
    const session = random();
    const expires = Date.now() + 86400000;
    await env.BLOG_DB.batch([
      env.BLOG_DB.prepare(
        "INSERT INTO connection(id,owner_id,display_name,tokens) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens,display_name=excluded.display_name"
      ).bind(me.id, me.displayName || "网站主人", await seal(env, tokens)),
      env.BLOG_DB.prepare("DELETE FROM sessions WHERE expires<?").bind(
        Date.now()
      ),
      env.BLOG_DB.prepare(
        "INSERT INTO sessions(hash,owner_id,expires) VALUES(?,?,?)"
      ).bind(await hash(session), me.id, expires),
    ]);
    const headers = new Headers({
      Location: `${env.APP_ORIGIN}/blog/manage/`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    headers.append("Set-Cookie", cookie(env, "blog_session", session, 86400));
    headers.append("Set-Cookie", cookie(env, "blog_oauth", "", 0));
    return new Response(null, { status: 302, headers });
  }
  if (path === "public" && request.method === "GET") {
    const result = await env.BLOG_DB.prepare(
      "SELECT slug,title FROM shares WHERE enabled=1 ORDER BY rowid DESC"
    ).all();
    return json({ notes: result.results });
  }
  if (path.startsWith("public/") && request.method === "GET") {
    const shared = await env.BLOG_DB.prepare(
      "SELECT * FROM shares WHERE slug=? AND enabled=1"
    )
      .bind(path.slice(7))
      .first();
    if (!shared) fail(404, "文章不存在或已取消分享。");
    await insideVault(env, row, shared.item_id);
    const item = await graph(
      env,
      row,
      `${itemPath(shared.item_id)}?$select=${fields}`
    );
    return json({
      slug: shared.slug,
      title: item.name.replace(/\.md$/i, ""),
      markdown: readableMarkdown(await contents(env, row, item)),
      modified: item.lastModifiedDateTime,
      assets: JSON.parse(shared.assets).map((asset) => ({
        ref: asset.ref,
        url: `/api/blog/media/${shared.slug}/${encodeURIComponent(asset.id)}`,
      })),
    });
  }
  if (path.startsWith("media/") && request.method === "GET") {
    const [, slug, assetId] = path.split("/");
    const shared = await env.BLOG_DB.prepare(
      "SELECT assets FROM shares WHERE slug=? AND enabled=1"
    )
      .bind(slug)
      .first();
    const asset =
      shared &&
      JSON.parse(shared.assets).find(
        (a) => a.id === decodeURIComponent(assetId)
      );
    if (!asset) fail(404, "附件未分享。");
    await insideVault(env, row, asset.id);
    const item = await graph(
      env,
      row,
      `${itemPath(asset.id)}?$select=${fields}`
    );
    if (item.size > 20 * 1024 * 1024) fail(413, "附件超过当前支持的 20 MB。");
    const redirect = await fetch(
      `${graphOrigin}${itemPath(asset.id)}/content`,
      {
        headers: { Authorization: `Bearer ${await accessToken(env, row)}` },
        redirect: "manual",
      }
    );
    const location = redirect.headers.get("Location");
    if (
      redirect.status !== 302 ||
      !location ||
      new URL(location).protocol !== "https:"
    )
      fail(502, "附件读取失败。");
    const download = await fetch(location);
    if (!download.ok) fail(502, "附件读取失败。");
    const mime = item.file?.mimeType || "application/octet-stream";
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(mime);
    return new Response(download.body, {
      headers: {
        "Content-Type": inline ? mime : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  await owner(request, env, row);
  if (request.method !== "GET") sameOrigin(request, env);
  if (path === "folders" && request.method === "GET") {
    const parent = url.searchParams.get("parent") || "root";
    let next = `${graphOrigin}${parent === "root" ? "/me/drive/root" : itemPath(parent)}/children?$select=${fields}&$top=200`;
    const items = [];
    do {
      if (!next.startsWith(`${graphOrigin}/`))
        fail(502, "OneDrive 分页地址无效。");
      const response = await fetch(next, {
        headers: { Authorization: `Bearer ${await accessToken(env, row)}` },
      });
      if (!response.ok) fail(502, "文件夹读取失败。");
      const page = await response.json();
      items.push(...page.value);
      next = page["@odata.nextLink"];
      if (items.length > 5000)
        fail(400, "此文件夹文件过多，请选择更小的子文件夹。");
    } while (next);
    const shares = (
      await env.BLOG_DB.prepare("SELECT item_id,slug,enabled FROM shares").all()
    ).results;
    return json({
      items: items
        .filter(
          (item) =>
            !item.name.startsWith(".") &&
            (item.folder || item.name.toLowerCase().endsWith(".md"))
        )
        .map((item) => ({
          id: item.id,
          name: item.name,
          folder: Boolean(item.folder),
          size: item.size,
          share: shares.find(
            (share) => share.item_id === item.id && share.enabled
          ),
        })),
    });
  }
  if (path === "root" && request.method === "PUT") {
    const data = await payload(request);
    if (typeof data.id !== "string" || data.id.length > 200)
      fail(400, "文件夹无效。");
    const item = await graph(
      env,
      row,
      `${itemPath(data.id)}?$select=${fields}`
    );
    if (!item.folder || item.name.startsWith("."))
      fail(400, "请选择笔记库文件夹。");
    if (row.vault_id === item.id) return json({ vaultId: item.id });
    await env.BLOG_DB.batch([
      env.BLOG_DB.prepare("UPDATE connection SET vault_id=? WHERE id=1").bind(
        item.id
      ),
      env.BLOG_DB.prepare("UPDATE shares SET enabled=0"),
    ]);
    return json({ vaultId: item.id });
  }
  if (path === "preview" && request.method === "GET")
    return json(await preview(env, row, url.searchParams.get("item") || ""));
  if (path === "shares" && request.method === "POST") {
    const data = await payload(request);
    if (
      typeof data.id !== "string" ||
      !Array.isArray(data.assetIds) ||
      !data.assetIds.every((id) => typeof id === "string")
    )
      fail(400, "分享选择无效。");
    const note = await preview(env, row, data.id);
    if (
      data.assetIds.some((id) => !note.assets.some((asset) => asset.id === id))
    )
      fail(400, "附件选择已发生变化，请重新预览。");
    const existing = await env.BLOG_DB.prepare(
      "SELECT slug FROM shares WHERE item_id=?"
    )
      .bind(data.id)
      .first();
    const slug = existing?.slug || crypto.randomUUID();
    await env.BLOG_DB.prepare(
      "INSERT INTO shares(item_id,slug,title,assets,enabled) VALUES(?,?,?,?,1) ON CONFLICT(item_id) DO UPDATE SET title=excluded.title,assets=excluded.assets,enabled=1"
    )
      .bind(
        data.id,
        slug,
        note.title,
        JSON.stringify(
          note.assets.filter((asset) => data.assetIds.includes(asset.id))
        )
      )
      .run();
    return json({ slug, url: `${env.APP_ORIGIN}/blog/n/${slug}/` });
  }
  if (path === "shares" && request.method === "DELETE") {
    const data = await payload(request);
    if (typeof data.id !== "string") fail(400, "笔记无效。");
    await env.BLOG_DB.prepare("UPDATE shares SET enabled=0 WHERE item_id=?")
      .bind(data.id)
      .run();
    return json({ ok: true });
  }
  if (path === "logout" && request.method === "POST") {
    await env.BLOG_DB.prepare("DELETE FROM sessions WHERE hash=?")
      .bind(await hash(cookieValue(request, "blog_session")))
      .run();
    return new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": cookie(env, "blog_session", "", 0),
        "Cache-Control": "no-store",
      },
    });
  }
  fail(404, "接口不存在。");
}
