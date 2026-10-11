import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useEffect, useRef, useState } from "react";

type Status = {
  configured: boolean;
  connected: boolean;
  authenticated: boolean;
  name?: string;
  vaultId?: string;
};
type Item = {
  id: string;
  name: string;
  folder: boolean;
  share?: { slug: string };
};
type Note = {
  id?: string;
  title: string;
  markdown: string;
  modified?: string;
  assets: {
    id?: string;
    name?: string;
    ref: string;
    url?: string;
    originalUrl?: string;
  }[];
  missing?: string[];
};
async function api(path: string, method = "GET", data?: unknown) {
  const response = await fetch(`/api/blog/${path}`, {
    body: data ? JSON.stringify(data) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    headers: data ? { "Content-Type": "application/json" } : {},
    method,
  });
  const result =
    response.status === 204
      ? {}
      : await response.json().catch(() => ({
          error: "连接服务未启动，请使用完整的博客预览地址。",
        }));
  if (!response.ok) {
    throw new Error(result.error || "读取失败，请稍后再试。");
  }
  return result;
}
function Markdown({ note }: { note: Note }) {
  const article = useRef<HTMLElement>(null);
  const assets = new Map(
    note.assets
      .filter((asset) => asset.url)
      .map((asset) => [asset.ref, asset.url!])
  );
  const escape = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const safeUrl = (href: string) => {
    if (assets.has(href)) return assets.get(href)!;
    try {
      const url = new URL(href);
      return /^https?:$/.test(url.protocol) &&
        !/^(localhost|127\.|\[::1\])/i.test(url.hostname)
        ? href
        : null;
    } catch {
      return null;
    }
  };
  const parser = new Marked({
    renderer: {
      html() {
        return "";
      },
      image({ href, text }) {
        const url = safeUrl(href);
        if (!url) return `<span>[图片尚未接入或未分享：${escape(text)}]</span>`;
        const original =
          note.assets.find((asset) => asset.ref === href)?.originalUrl || url;
        return `<a class="note-image" href="${escape(original)}" target="_blank" rel="noopener noreferrer" aria-label="查看原图：${escape(text)}"><img data-src="${escape(url)}" alt="${escape(text)}" width="240" height="180" decoding="async"><span class="image-status">图片待加载 · 点击查看原图</span></a>`;
      },
      link({ href, tokens }) {
        const url = safeUrl(href);
        const text = this.parser.parseInline(tokens);
        return url
          ? `<a href="${escape(url)}" rel="noopener noreferrer">${text}</a>`
          : `${text} <small>（链接未接入）</small>`;
      },
    },
  });
  const html = DOMPurify.sanitize(
    parser.parse(note.markdown, { async: false }),
    {
      FORBID_ATTR: ["style"],
      FORBID_TAGS: ["style", "form", "video", "audio"],
      SANITIZE_NAMED_PROPS: true,
      USE_PROFILES: { html: true },
    }
  );
  useEffect(() => {
    const images =
      article.current?.querySelectorAll<HTMLImageElement>("img[data-src]");
    if (!images) return;
    const load = (img: HTMLImageElement) => {
      img.onload = () => {
        img.parentElement?.classList.add("image-loaded");
        const status = img.parentElement?.querySelector(".image-status");
        if (status) status.textContent = "点击查看原图 ↗";
      };
      img.onerror = () => {
        const status = img.parentElement?.querySelector(".image-status");
        if (status) status.textContent = "图片加载失败 · 点击尝试查看原图";
      };
      img.src = img.dataset.src!;
    };
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                if (entry.isIntersecting) {
                  load(entry.target as HTMLImageElement);
                  observer?.unobserve(entry.target);
                }
            },
            { rootMargin: "200px" }
          )
        : null;
    images.forEach((img) => (observer ? observer.observe(img) : load(img)));
    return () => {
      observer?.disconnect();
      images.forEach((img) => {
        img.onload = null;
        img.onerror = null;
      });
    };
  }, [html]);
  return (
    <article
      ref={article}
      className="note-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
export function OneDriveManager() {
  const [status, setStatus] = useState<Status>();
  const [items, setItems] = useState<Item[]>([]);
  const [trail, setTrail] = useState([{ id: "root", name: "OneDrive" }]);
  const [note, setNote] = useState<Note>();
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("正在检查 OneDrive 连接…");
  const [sharedUrl, setSharedUrl] = useState("");
  const [query, setQuery] = useState("");
  async function browse(nextTrail: typeof trail) {
    const result = await api(
      `folders?parent=${encodeURIComponent(nextTrail.at(-1)!.id)}`
    );
    setItems(result.items);
    setTrail(nextTrail);
    setNote(undefined);
    setSharedUrl("");
  }
  useEffect(() => {
    void (async () => {
      try {
        const state = await api("status");
        setStatus(state);
        if (state.authenticated) {
          await browse(
            state.vaultId
              ? [
                  { id: "root", name: "OneDrive" },
                  { id: state.vaultId, name: "笔记库" },
                ]
              : trail
          );
          setMessage(
            state.vaultId
              ? "选择要分享的笔记，先查看正文和附件。"
              : "打开你的笔记库文件夹，然后点击“设为笔记库”。"
          );
        } else {
          setMessage(
            state.configured
              ? "请连接网站主人的微软账号。"
              : "微软连接配置尚未完成，暂时不能读取 OneDrive。"
          );
        }
      } catch (error) {
        setMessage(String(error));
      } finally {
        setBusy(false);
      }
    })();
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败。");
    } finally {
      setBusy(false);
    }
  }
  const parent = trail.at(-1)!;
  if (!status?.authenticated) {
    return (
      <section className="blog-callout">
        <div>
          <h2>连接你的 OneDrive</h2>
          <p>
            用微软账号登录，然后选择笔记库和要公开的文章。访客阅读无需登录。
          </p>
          <p role="status">{message}</p>
          <p>本阶段申请文件读取权限，笔记原文件保持不变。</p>
          {status?.configured && (
            <a className="button" href="/api/blog/auth/start">
              用微软账号连接 OneDrive →
            </a>
          )}
        </div>
      </section>
    );
  }
  return (
    <>
      <div className="section-bar">
        <span>已连接 · {status.name}</span>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api("logout", "POST", {});
              setStatus({ ...status, authenticated: false });
              setMessage("已退出。已选择分享的文章仍可阅读。");
            })
          }
        >
          退出登录
        </button>
      </div>
      <div className="preview-notice">
        已分享笔记引用的 OE Link 图片会自动从 OneDrive
        读取；其他附件需勾选。更换笔记库会取消之前的分享；重新分享同一篇文章会保留链接。
      </div>
      <div className="workspace">
        <aside className="note-sidebar">
          <nav className="folder-trail" aria-label="文件夹路径">
            {trail.map((folder, index) => (
              <button
                key={folder.id}
                disabled={busy}
                onClick={() =>
                  void run(() => browse(trail.slice(0, index + 1)))
                }
              >
                {folder.name}
              </button>
            ))}
          </nav>
          {parent.id !== "root" && (
            <button
              className="button"
              disabled={busy || status.vaultId === parent.id}
              onClick={() =>
                void run(async () => {
                  await api("root", "PUT", { id: parent.id });
                  setStatus({ ...status, vaultId: parent.id });
                  await browse(trail);
                  setMessage("已设置笔记库。现在可以预览并选择分享的笔记。");
                })
              }
            >
              {status.vaultId === parent.id ? "当前笔记库" : "设为笔记库"}
            </button>
          )}
          <label className="search-label">
            查找文件
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按文件名搜索…"
            />
          </label>
          <div className="sidebar-list">
            {items
              .filter((item) =>
                item.name
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase())
              )
              .map((item) => (
                <button
                  key={item.id}
                  disabled={busy}
                  className={note?.id === item.id ? "selected" : ""}
                  onClick={() =>
                    void run(async () => {
                      if (item.folder) {
                        await browse([
                          ...trail,
                          { id: item.id, name: item.name },
                        ]);
                        return;
                      }
                      const preview = await api(
                        `preview?item=${encodeURIComponent(item.id)}`
                      );
                      setNote(preview);
                      setSelectedAssets([]);
                      setSharedUrl(
                        item.share
                          ? `${location.origin}/blog/n/${item.share.slug}/`
                          : ""
                      );
                      setMessage("检查这篇笔记是否适合公开，再点击分享。");
                    })
                  }
                >
                  <strong>
                    {item.folder ? "▸ " : ""}
                    {item.name}
                  </strong>
                  <span>
                    {item.folder ? "文件夹" : item.share ? "已分享" : "未分享"}
                  </span>
                </button>
              ))}
          </div>
          {!items.length && (
            <p className="muted">这个文件夹里没有可显示的笔记或子文件夹。</p>
          )}
        </aside>
        <section className="cloud-note-preview">
          {note ? (
            <>
              <h2>{note.title}</h2>
              <p className="muted">
                以下正文会对所有访客公开。Obsidian
                双链、白板和插件语法暂未完整适配。
              </p>
              <details className="share-assets" open>
                <summary>
                  同时公开的图片与附件（{selectedAssets.length}）
                </summary>
                {note.assets.map((asset) => (
                  <label key={`${asset.id}-${asset.ref}`}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={selectedAssets.includes(asset.id!)}
                      onChange={(event) =>
                        setSelectedAssets(
                          event.target.checked
                            ? [...selectedAssets, asset.id!]
                            : selectedAssets.filter((id) => id !== asset.id)
                        )
                      }
                    />
                    {asset.name} <small>{asset.ref}</small>
                  </label>
                ))}
                {!note.assets.length && (
                  <p className="muted">
                    没有找到可选择的标准 Markdown 本地附件。
                  </p>
                )}
                {Boolean(note.missing?.length) && (
                  <p className="muted">
                    以下附件未找到或超过大小限制：{note.missing!.join("、")}
                  </p>
                )}
              </details>
              <div className="share-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api("shares", "POST", {
                        assetIds: selectedAssets,
                        id: note.id,
                      });
                      setSharedUrl(result.url);
                      setMessage(
                        "已分享。未登录访客可通过下方链接阅读这篇笔记。"
                      );
                      const list = await api(
                        `folders?parent=${encodeURIComponent(parent.id)}`
                      );
                      setItems(list.items);
                    })
                  }
                >
                  公开这篇笔记及勾选附件
                </button>
                {sharedUrl && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api("shares", "DELETE", { id: note.id });
                        setSharedUrl("");
                        setMessage(
                          "已取消分享，原链接将不能继续读取文章或附件。"
                        );
                        const list = await api(
                          `folders?parent=${encodeURIComponent(parent.id)}`
                        );
                        setItems(list.items);
                      })
                    }
                  >
                    取消分享
                  </button>
                )}
              </div>
              {sharedUrl && (
                <label className="search-label">
                  分享链接
                  <input
                    readOnly
                    value={sharedUrl}
                    onFocus={(event) => event.target.select()}
                  />
                  <a href={sharedUrl} target="_blank" rel="noopener noreferrer">
                    打开访客阅读页 ↗
                  </a>
                </label>
              )}
              <Markdown note={note} />
            </>
          ) : (
            <div className="cloud-empty">
              <h2>从 OneDrive 选择一篇笔记</h2>
              <p>先设定笔记库，再查看文章正文和附件，最后决定是否分享。</p>
            </div>
          )}
        </section>
      </div>
      <p role="status" className="workspace-status">
        {busy ? "正在读取 OneDrive…" : message}
      </p>
    </>
  );
}
export function SharedNotes() {
  const [notes, setNotes] = useState<{ title: string; slug: string }[]>([]);
  const [message, setMessage] = useState("正在读取已分享笔记…");
  const [query, setQuery] = useState("");
  useEffect(() => {
    void api("public")
      .then((result) => {
        setNotes(result.notes);
        setMessage(result.notes.length ? "" : "暂时还没有公开的笔记。");
      })
      .catch((error) => setMessage(error.message));
  }, []);
  const visible = notes.filter((note) =>
    note.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  return (
    <>
      <div className="section-bar">
        <h2>
          已分享笔记 <span>{notes.length}</span>
        </h2>
      </div>
      <label className="search-label">
        搜索笔记
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索文章标题…"
        />
      </label>
      <p role="status" className="muted">
        {message || (visible.length ? "" : "没有匹配的笔记。")}
      </p>
      <div className="note-grid">
        {visible.map((note) => (
          <a
            className="note-card"
            key={note.slug}
            href={`/blog/n/${note.slug}/`}
          >
            <h3>{note.title}</h3>
            <p>阅读全文 ↗</p>
          </a>
        ))}
      </div>
    </>
  );
}
export function SharedReader() {
  const [note, setNote] = useState<Note>();
  const [message, setMessage] = useState("正在从 OneDrive 读取文章…");
  useEffect(() => {
    const slug = location.pathname.split("/").filter(Boolean).at(-1);
    if (!slug || slug === "read") {
      setMessage("请通过文章的分享链接打开。");
      return;
    }
    void api(`public/${encodeURIComponent(slug)}`)
      .then(setNote)
      .catch((error) => setMessage(error.message));
  }, []);
  return (
    <>
      <a className="back-link" href="/blog/">
        ← 已分享笔记
      </a>
      {note ? (
        <>
          <header className="article-header">
            <h1>{note.title}</h1>
            {note.modified && (
              <p>更新于 {new Date(note.modified).toLocaleString("zh-CN")}</p>
            )}
          </header>
          <Markdown note={note} />
        </>
      ) : (
        <p role="status">{message}</p>
      )}
    </>
  );
}
