import assert from "node:assert/strict";
import { activeSessionTitle, sessionTitle } from "../src/lib/sessionTitle.ts";
import type { SessionInfo } from "../src/types.ts";
import { test } from "vitest";

test("session title", async () => {
  const session: SessionInfo = {
    file: "D:\\sessions\\task.jsonl",
    sessionId: "01a0288a-full-id",
    cwd: "D:\\workspace",
    firstMessage: "按照paseo",
    messageCount: 4,
  };

  assert.equal(sessionTitle(session), "按照paseo");
  assert.equal(activeSessionTitle({
    sessions: [session],
    sessionFile: "d:/sessions/task.jsonl",
    sessionId: session.sessionId,
    sessionName: null,
  }), "按照paseo", "header should use the same first-message fallback as the sidebar");

  assert.equal(activeSessionTitle({
    sessions: [session],
    sessionFile: session.file,
    sessionId: session.sessionId,
    sessionName: "显式任务名称",
  }), "显式任务名称", "runtime session name should override the first message");

  assert.equal(activeSessionTitle({
    sessions: [],
    sessionFile: session.file,
    sessionId: session.sessionId,
    sessionName: null,
    firstMessage: "按照paseo",
  }), "按照paseo", "live messages should cover metadata refresh delays");

  assert.equal(activeSessionTitle({
    sessions: [],
    sessionId: session.sessionId,
    sessionName: null,
  }), "任务 01a0288a", "task id remains the final fallback");

  assert.equal(
    sessionTitle({
      ...session,
      firstMessage:
        "/frontend-design 我感觉现在千机里面很多细节都不够美观，比如说我在用skill或者命令的时候，在agent和bot页面的消息气泡里面都是一个文本",
    }),
    "我感觉现在千机里面很多细节都不够美观，比如说我在用skill或者命令的时候，在agent和bot页面的消息气泡里面都是一个文本",
    "long leading slash/skill directives must never be misclassified as filesystem paths",
  );

  assert.equal(
    sessionTitle({
      ...session,
      firstMessage:
        "/skill:frontend-design 帮我检查输入框与消息卡片\n\n附加的本地文件：\n- Composer.tsx: D:\\work\\PI-Desktop\\src\\components\\Composer.tsx",
    }),
    "帮我检查输入框与消息卡片",
    "trailing local file attachment manifests and Windows backslashes must not turn titles into 未命名对话",
  );

  assert.equal(
    sessionTitle({
      ...session,
      firstMessage: "\n\n附加的本地文件：\n- design-spec.pdf: D:\\docs\\design-spec.pdf",
    }),
    "design-spec.pdf",
    "attachment-only messages fall back to concise attachment filename",
  );

  assert.equal(
    sessionTitle({
      ...session,
      firstMessage: "> 上一轮讨论摘要\n\n[已关联连接器上下文: Gmail, GitHub]\n帮我整理今天的待办事项",
    }),
    "帮我整理今天的待办事项",
    "leading reply quotes and connector headers are stripped cleanly from session titles",
  );
});
