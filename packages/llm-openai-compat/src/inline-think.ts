/**
 * Streaming state machine that extracts leading `<think>...</think>` and
 * `<thinking>...</thinking>` blocks (case-insensitive, with optional `\r?\n`
 * immediately after the opening tag) from `delta.content` across arbitrary SSE
 * chunk boundaries while immediately flushing non-thinking tags (e.g. `<div>`,
 * `<table`, `<thinkpad>`, `<section>`) as prose on the diverging character.
 */

export interface ThinkSegment {
  kind: "thinking" | "text";
  text: string;
}

const OPEN_THINK_STEM_LEN = "<think".length;
const OPEN_THINKING_TAG = "<thinking>";
const CLOSE_THINK_TAG = "</think>";
const CLOSE_THINKING_TAG = "</thinking>";

export class InlineThinkParser {
  private state: "leading" | "in-think" | "text" = "leading";
  private activeCloseTag = CLOSE_THINK_TAG;
  private wsBuf = "";
  private tagBuf = "";
  private closeBuf = "";
  private stripOpenNewline = false;
  private pendingOpenCr = false;
  sawInput = false;
  sawThinkBlock = false;

  private enterInThink(closeTag: string): void {
    this.wsBuf = "";
    this.tagBuf = "";
    this.sawThinkBlock = true;
    this.state = "in-think";
    this.activeCloseTag = closeTag;
    this.stripOpenNewline = true;
    this.pendingOpenCr = false;
  }

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
      const expected = this.activeCloseTag[this.closeBuf.length];
      if (expected !== undefined && c.toLowerCase() === expected) {
        this.closeBuf += c;
        if (this.closeBuf.length === this.activeCloseTag.length) {
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
          const pos = this.tagBuf.length;
          const lower = ch.toLowerCase();
          if (pos === OPEN_THINK_STEM_LEN && ch === ">") {
            this.enterInThink(CLOSE_THINK_TAG);
          } else if (OPEN_THINKING_TAG[pos] !== undefined && lower === OPEN_THINKING_TAG[pos]) {
            this.tagBuf += ch;
            if (this.tagBuf.length === OPEN_THINKING_TAG.length) {
              this.enterInThink(CLOSE_THINKING_TAG);
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
