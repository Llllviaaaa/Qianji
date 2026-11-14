/**
 * Fence-aware block splitter for streaming Markdown.
 * Splits only on blank-line boundaries outside open ``` / ~~~ fences so
 * completed preceding blocks stay referentially identical across tokens
 * and unclosed/streaming fences stay together in the single trailing block.
 */
export function splitStreamingMarkdownBlocks(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  let currentLines: string[] = [];
  let activeFence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    if (!activeFence && line.trim() === "") {
      if (currentLines.length > 0) {
        blocks.push(currentLines.join("\n"));
        currentLines = [];
      }
      continue;
    }

    currentLines.push(line);

    if (!activeFence) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opening) {
        const marker = opening[1][0] as "`" | "~";
        const info = opening[2] ?? "";
        if (marker === "~" || !info.includes("`")) {
          activeFence = { marker, length: opening[1].length };
        }
      }
      continue;
    }

    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (closing && closing[1][0] === activeFence.marker && closing[1].length >= activeFence.length) {
      activeFence = null;
    }
  }

  if (currentLines.length > 0) {
    blocks.push(currentLines.join("\n"));
  }
  return blocks;
}
