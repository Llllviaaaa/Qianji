import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";
import { normalizeMarkdownUrl } from "../src/lib/markdownFileLinks";
import { test } from "vitest";

test("markdown file links", async () => {
  const rendered = renderToStaticMarkup(createElement(Markdown, {
    content: "Open src/App.tsx:42, `README.md`, report.pdf, sheet.xlsx, 文档/方案.docx, and [Spec](file:///D:/work/spec.pdf) or [Local](./docs/guide.md).",
  }));

  assert.match(rendered, /href="pifile:\/\/src%2FApp\.tsx#L42"/);
  assert.match(rendered, /href="pifile:\/\/README\.md"/);
  assert.match(rendered, /href="pifile:\/\/report\.pdf"/);
  assert.match(rendered, /href="pifile:\/\/sheet\.xlsx"/);
  assert.match(rendered, /href="pifile:\/\/%E6%96%87%E6%A1%A3%2F%E6%96%B9%E6%A1%88\.docx"/);
  assert.match(rendered, /href="pifile:\/\/D%3A%2Fwork%2Fspec\.pdf"/);
  assert.match(rendered, /href="pifile:\/\/\.%2Fdocs%2Fguide\.md"/);
  assert.match(rendered, /class="file-ref"/);

  assert.equal(normalizeMarkdownUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(normalizeMarkdownUrl("#section-1"), "#section-1");
  assert.equal(normalizeMarkdownUrl("file:///C:/Users/demo/notes.md#L12"), "pifile://C%3A%2FUsers%2Fdemo%2Fnotes.md#L12");
  assert.equal(normalizeMarkdownUrl("D:\\docs\\report.pdf"), "pifile://D%3A%5Cdocs%5Creport.pdf");
  assert.equal(normalizeMarkdownUrl("docs/manual.txt"), "pifile://docs%2Fmanual.txt");

  const table = renderToStaticMarkup(createElement(Markdown, {
    content: "| Name | Value |\n| --- | --- |\n| Width | 760px |",
  }));

  assert.match(table, /class="markdown-table-scroll"/);
  assert.match(table, /role="region"/);
  assert.match(table, /aria-label="表格内容，可横向滚动"/);
  assert.match(table, /tabindex="0"/);
  assert.match(table, /<table>/);
});
