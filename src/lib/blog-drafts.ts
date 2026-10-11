export type Draft = {
  id: string;
  title: string;
  body: string;
  revision: string;
};
export const storageKey = "polaris-blog-local-drafts-v1";
export const maxNoteSize = 2 * 1024 * 1024;

export function readDrafts(raw: string | null, samples: Draft[]): Draft[] {
  if (raw === null) return samples;
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    !value.every(
      (note) =>
        note &&
        typeof note.id === "string" &&
        typeof note.title === "string" &&
        typeof note.body === "string" &&
        typeof note.revision === "string"
    ) ||
    new Set(value.map((note) => note.id)).size !== value.length
  ) {
    throw new Error("本地草稿数据无法读取。原数据已保留，请先导出当前内容。");
  }
  return value;
}

export function prepareSave(
  current: string | null,
  expected: string | null,
  notes: Draft[],
  draft: Draft
) {
  if (current !== expected)
    throw new Error(
      "另一个页面更新了草稿。为避免覆盖，保存已停止；请先导出当前内容，再重新读取草稿。"
    );
  if (!draft.title.trim()) throw new Error("请先填写笔记标题。");
  if (new TextEncoder().encode(draft.body).byteLength > maxNoteSize)
    throw new Error("单篇笔记超过 2 MB，请拆分后再保存。");
  const saved = {
    ...draft,
    title: draft.title.trim(),
    revision: crypto.randomUUID(),
  };
  const next = notes.some((note) => note.id === saved.id)
    ? notes.map((note) => (note.id === saved.id ? saved : note))
    : [...notes, saved];
  return { notes: next, draft: saved, raw: JSON.stringify(next) };
}
