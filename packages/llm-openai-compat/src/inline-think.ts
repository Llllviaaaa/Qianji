/**
 * Streaming state machine that extracts leading `<think>...</think>` blocks
 * (case-insensitive, with optional `\r?\n` immediately after `<think>`) from
 * `delta.content` across arbitrary SSE chunk boundaries while immediately
 * flushing non-`<think>` tags (e.g. `<div>`, `<table`, `<thinking>`) as prose.
 */

export interface ThinkSegment {
  kind: "thinking" | "text";
  text: string;
}

const OPEN_THINK_TAG = "<think>";
const CLOSE_THINK_TAG = "</think>";

export class InlineThinkParser {
  private state: "leading" | "in-think" | "text" = "leading";
  private wsBuf = "";
  private tagBuf = "";
  private closeBuf = "";
  private stripOpenNewline = false;
  private pendingOpenCr = false;
  sawInput = false;
  sawThinkBlock = false;

  push(chunk: string): ThinkSegment[] {
    if (chunk === "") return [];
    this.sawInput = true;
    if (this.state === "text") {
      return [{ kind: "text", text: chunk }];
    }

    const segments: ThinkSegment[] = [];
    const append = (kind: "thinking" | "text", text: string): void => {
      if (text === "") return;
      const last = segments.at(-1);
      if (last !== undefined && last.kind === kind) {
        last.text += text;
      } else {
        segments.push({ kind, text });
      }
    };

    const feedInThinkChar = (c: string): void => {
      if (this.closeBuf === "") {
        if (c === "<") {
          this.closeBuf = "<";
        } else {
          append("thinking", c);
        }
        return;
      }
      const expected = CLOSE_THINK_TAG[this.closeBuf.length];
      if (expected !== undefined && c.toLowerCase() === expected) {
        this.closeBuf += c;
        if (this.closeBuf.length === CLOSE_THINK_TAG.length) {
          this.closeBuf = "";
          this.state = "leading";
          this.wsBuf = "";
          this.tagBuf = "";
        }
        return;
      }
      append("thinking", this.closeBuf);
      if (c === "<") {
        this.closeBuf = "<";
      } else {
        this.closeBuf = "";
        append("thinking", c);
      }
    };

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i] ?? "";
      if (this.state === "leading") {
        if (this.tagBuf === "") {
          if (/\s/.test(ch)) {
            this.wsBuf += ch;
          } else if (ch === "<") {
            this.tagBuf = "<";
          } else {
            if (!this.sawThinkBlock && this.wsBuf !== "") {
              append("text", this.wsBuf);
            }
            this.wsBuf = "";
            this.state = "text";
            append("text", chunk.slice(i));
            break;
          }
        } else {
          const expected = OPEN_THINK_TAG[this.tagBuf.length];
          if (expected !== undefined && ch.toLowerCase() === expected) {
            this.tagBuf += ch;
            if (this.tagBuf.length === OPEN_THINK_TAG.length) {
              this.wsBuf = "";
              this.tagBuf = "";
              this.sawThinkBlock = true;
              this.state = "in-think";
              this.stripOpenNewline = true;
              this.pendingOpenCr = false;
            }
          } else {
            const prefix = (this.sawThinkBlock ? "" : this.wsBuf) + this.tagBuf;
            this.wsBuf = "";
            this.tagBuf = "";
            this.state = "text";
            append("text", prefix + chunk.slice(i));
            break;
          }
        }
      } else {
        if (this.stripOpenNewline) {
          if (this.pendingOpenCr) {
            this.pendingOpenCr = false;
            this.stripOpenNewline = false;
            if (ch === "\n") {
              continue;
            }
            feedInThinkChar("\r");
          } else if (ch === "\r") {
            this.pendingOpenCr = true;
            continue;
          } else if (ch === "\n") {
            this.stripOpenNewline = false;
            continue;
          } else {
            this.stripOpenNewline = false;
          }
        }
        feedInThinkChar(ch);
      }
    }

    return segments;
  }

  finish(): ThinkSegment[] {
    if (this.state === "leading") {
      const flushed = this.tagBuf !== ""
        ? (this.sawThinkBlock ? "" : this.wsBuf) + this.tagBuf
        : (this.sawThinkBlock ? "" : this.wsBuf);
      this.wsBuf = "";
      this.tagBuf = "";
      this.state = "text";
      return flushed === "" ? [] : [{ kind: "text", text: flushed }];
    }
    if (this.state === "in-think") {
      const leftover = (this.pendingOpenCr ? "\r" : "") + this.closeBuf;
      this.pendingOpenCr = false;
      this.stripOpenNewline = false;
      this.closeBuf = "";
      this.state = "text";
      return leftover === "" ? [] : [{ kind: "thinking", text: leftover }];
    }
    return [];
  }
}
