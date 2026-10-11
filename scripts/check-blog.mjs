import assert from "node:assert/strict";
import { prepareSave, readDrafts } from "../src/lib/blog-drafts.ts";
const sample = {
  id: "fixed-id",
  title: "示例",
  body: "# 正文",
  revision: "sample",
};
const first = prepareSave(null, null, [sample], { ...sample, title: "新标题" });
assert.equal(first.notes[0].id, "fixed-id");
assert.equal(first.notes[0].title, "新标题");
assert.deepEqual(readDrafts(first.raw, []), first.notes);
assert.throws(
  () => prepareSave(first.raw, null, [sample], sample),
  /另一个页面/
);
assert.throws(
  () => prepareSave(null, null, [], { ...sample, title: " " }),
  /标题/
);
assert.throws(() => readDrafts('{"broken":true}', []));
assert.throws(() => readDrafts(JSON.stringify([sample, sample]), []));
assert.equal(prepareSave(null, null, [], sample).notes.length, 1);
assert.throws(
  () => prepareSave(null, null, [], { ...sample, body: "中".repeat(800000) }),
  /2 MB/
);
console.log(
  "博客草稿检查通过：保存、固定 ID、冲突拒绝、损坏数据保护、大小限制。"
);
