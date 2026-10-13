import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";

export type Note = {
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
export function Markdown({ note }: { note: Note }) {
  const article = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [viewer, setViewer] = useState<{
    original: string;
    preview: string;
    alt: string;
    loaded: boolean;
    error: boolean;
    attempt: number;
  }>();
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
        return `<a class="note-image" href="${escape(original)}" aria-label="放大图片：${escape(text)}"><img data-src="${escape(url)}" alt="${escape(text)}" decoding="async"></a>`;
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
  const content = useMemo(() => ({ __html: html }), [html]);
  useEffect(() => {
    const images =
      article.current?.querySelectorAll<HTMLImageElement>("img[data-src]");
    if (!images) return;
    const load = (img: HTMLImageElement) => {
      img.onload = () => {
        img.parentElement?.classList.add("image-loaded");
      };
      img.onerror = () => {
        img.parentElement?.classList.add("image-error");
        img.parentElement?.setAttribute("title", "图片加载失败，点击重试原图");
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
  useEffect(() => {
    if (viewer && !dialog.current?.open) dialog.current?.showModal();
  }, [viewer]);
  return (
    <>
      <article
        ref={article}
        className="note-prose"
        onClick={(event) => {
          const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
            "a.note-image"
          );
          if (!link) return;
          event.preventDefault();
          const image = link.querySelector("img")!;
          setViewer({
            original: link.href,
            preview: image.currentSrc || image.dataset.src!,
            alt: image.alt,
            loaded: false,
            error: false,
            attempt: 0,
          });
        }}
        dangerouslySetInnerHTML={content}
      />
      <dialog
        ref={dialog}
        className="image-viewer"
        aria-label="查看原图"
        onClose={() => setViewer(undefined)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {viewer && (
          <>
            <button
              className="image-viewer-close"
              autoFocus
              aria-label="关闭图片"
              onClick={() => dialog.current?.close()}
            >
              ×
            </button>
            <div className="image-viewer-stage">
              {!viewer.loaded && (
                <img className="viewer-preview" src={viewer.preview} alt="" />
              )}
              <img
                key={viewer.attempt}
                className={
                  viewer.loaded
                    ? "viewer-original"
                    : "viewer-original is-loading"
                }
                src={viewer.original}
                alt={viewer.alt}
                onLoad={() =>
                  setViewer(
                    (current) =>
                      current && { ...current, loaded: true, error: false }
                  )
                }
                onError={() =>
                  setViewer((current) => current && { ...current, error: true })
                }
              />
              {!viewer.loaded && (
                <div className="viewer-progress" role="status">
                  {viewer.error ? (
                    <>
                      <span>原图加载失败</span>
                      <button
                        onClick={() =>
                          setViewer({
                            ...viewer,
                            error: false,
                            attempt: viewer.attempt + 1,
                          })
                        }
                      >
                        重试
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="image-spinner" aria-hidden="true" />
                      <span className="sr-only">正在加载原图…</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
