import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  maxNoteSize,
  prepareSave,
  readDrafts,
  storageKey,
  type Draft,
} from "@/lib/blog-drafts";

export default function Workbench({ samples }: { samples: Draft[] }) {
  const [notes, setNotes] = useState<Draft[]>(samples);
  const [draft, setDraft] = useState<Draft>(samples[0]);
  const [expected, setExpected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState(
    "选择示例，或导入你自己的 Markdown 笔记。"
  );

  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      const loaded = readDrafts(raw, samples);
      setNotes(loaded);
      setDraft(loaded[0] || samples[0]);
      setExpected(raw);
      setDirty(false);
      setReady(true);
      setMessage("已读取本地草稿。内容尚未同步到 OneDrive。");
    } catch (error) {
      setReady(false);
      setMessage(String(error));
    }
  }
  useEffect(load, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function edit(change: Partial<Draft>) {
    setDraft({ ...draft, ...change });
    setDirty(true);
  }
  async function save() {
    setBusy(true);
    try {
      if (!ready) throw new Error("本地存储不可用，请导出 Markdown 保留内容。");
      if (!navigator.locks)
        throw new Error("此浏览器不支持安全的跨页面保存，请导出 Markdown。");
      // ponytail: one browser-wide lock; use per-note revisions when the OneDrive backend is connected.
      await navigator.locks.request(storageKey, () => {
        const next = prepareSave(
          localStorage.getItem(storageKey),
          expected,
          notes,
          draft
        );
        localStorage.setItem(storageKey, next.raw);
        setNotes(next.notes);
        setDraft(next.draft);
        setExpected(next.raw);
        setDirty(false);
        setMessage("已保存到此浏览器。尚未同步到 OneDrive，也未发布。");
      });
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "保存失败，请导出当前内容。"
      );
    } finally {
      setBusy(false);
    }
  }
  function exportNote() {
    const url = URL.createObjectURL(
      new Blob([draft.body], { type: "text/markdown;charset=utf-8" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim() || "笔记"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("已导出 Markdown；本地编辑仍需保存。尚未写入 OneDrive。");
  }
  async function importNote(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      if (!/\.md$/i.test(file.name)) throw new Error("请选择 .md 格式的笔记。");
      if (file.size > maxNoteSize)
        throw new Error("请选择小于 2 MB 的 Markdown 笔记。");
      const body = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer()
      );
      setDraft({
        id: crypto.randomUUID(),
        title: file.name.replace(/\.md$/i, ""),
        body,
        revision: "new",
      });
      setDirty(true);
      setMessage("已导入，保存后会留在此浏览器。原文件保持不变。");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "导入失败，请重新选择文件。"
      );
    } finally {
      setBusy(false);
    }
  }
  const html = DOMPurify.sanitize(marked.parse(draft.body, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "video", "audio"],
    FORBID_ATTR: ["style"],
    SANITIZE_NAMED_PROPS: true,
  });
  return (
    <>
      <div className="workspace">
        <aside className="note-sidebar">
          <div className="section-bar">
            <h2>
              本地笔记 <span>{notes.length}</span>
            </h2>
            <button
              aria-label="新建笔记"
              disabled={dirty || busy}
              onClick={() => {
                setDraft({
                  id: crypto.randomUUID(),
                  title: "未命名笔记",
                  body: "# 一个新的想法\n\n",
                  revision: "new",
                });
                setDirty(true);
              }}
            >
              ＋
            </button>
          </div>
          <label className="search-label">
            查找笔记
            <input
              type="search"
              placeholder="搜索标题…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="sidebar-list">
            {notes
              .filter((note) =>
                note.title
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase())
              )
              .map((note) => (
                <button
                  className={note.id === draft.id ? "selected" : ""}
                  key={note.id}
                  disabled={dirty || busy}
                  onClick={() => {
                    setDraft(note);
                    setMessage("已打开笔记。");
                  }}
                >
                  <strong>{note.title}</strong>
                  <span>
                    {note.revision === "sample" ? "示例笔记" : "本地草稿"}
                  </span>
                </button>
              ))}
          </div>
          <label className="button import-button">
            导入 Markdown
            <input
              type="file"
              aria-label="导入 Markdown"
              accept=".md,text/markdown"
              disabled={dirty || busy}
              onChange={(e) => {
                void importNote(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <p className="sidebar-tip">
            未保存时请先保存或导出。导入只读取所选文件，不会扫描整个笔记库。
          </p>
        </aside>
        <section className="editor-area">
          <div className="editor-toolbar">
            <span className="muted">
              {dirty ? "● 有未保存修改" : "○ 无未保存修改"}
            </span>
            <div>
              <button onClick={exportNote}>导出 .md</button>
              <button
                className="button"
                disabled={!dirty || busy || !ready}
                onClick={() => void save()}
              >
                {busy ? "保存中…" : "保存本地草稿"}
              </button>
            </div>
          </div>
          <label className="title-label">
            笔记标题
            <input
              disabled={busy}
              value={draft.title}
              maxLength={200}
              onChange={(e) => edit({ title: e.target.value })}
            />
          </label>
          <div className="editor-columns">
            <label className="markdown-label">
              <span>MARKDOWN</span>
              <textarea
                disabled={busy}
                aria-label="Markdown 正文"
                spellCheck={false}
                value={draft.body}
                onChange={(e) => edit({ body: e.target.value })}
              />
            </label>
            <section className="preview-pane" aria-label="阅读预览">
              <p className="pane-label">阅读预览</p>
              <article
                className="note-prose"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </section>
          </div>
        </section>
      </div>
      <div className="workspace-status">
        <p role="status">{message}</p>
        <button disabled={dirty || busy} onClick={load}>
          重新读取草稿
        </button>
      </div>
      {dirty && (
        <p className="muted">
          先保存当前修改，才能切换笔记。遇到保存冲突时，先导出
          .md，再刷新页面读取新版本。
        </p>
      )}
    </>
  );
}
