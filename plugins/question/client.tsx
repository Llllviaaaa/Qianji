import { useState, type KeyboardEvent } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { SlotComponentProps, SlotPropsOf } from "@qianji/client-slots";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  formatAnswerDisplay,
  isAllQuestionsAnswered,
  isQuestionAnswered,
  normalizeQuestionnaireInput,
  parseQuestionEnvelopeFromRequest,
  parseQuestionResultPayload,
  serializeQuestionResponse,
  type QuestionAnswerItem,
  type QuestionEnvelope,
  type QuestionItem,
} from "./shared.ts";
import { QUESTION_SCOPED_CSS } from "./styles.ts";

export const name = "question";
export const inject = ["slots", "styles"];

const OTHER_OPTION_VALUE = "__qianji_other__";

type ApprovalProps = SlotComponentProps<
  SlotPropsOf<"conversation.approvalDialog">,
  "session",
  unknown,
  QuestionEnvelope
>;

type ToolCallProps = SlotComponentProps<SlotPropsOf<"conversation.toolCall">, "session">;

export function QuestionApprovalCard({ request, onAnswer, selected }: ApprovalProps) {
  const envelope = selected ?? parseQuestionEnvelopeFromRequest(request);
  const requestId = typeof request.id === "string" ? request.id : "";

  const [trackedRequestId, setTrackedRequestId] = useState(requestId);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerItem>>({});
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherDraft, setOtherDraft] = useState("");
  const [reviewing, setReviewing] = useState(false);

  if (trackedRequestId !== requestId) {
    setTrackedRequestId(requestId);
    setIndex(0);
    setAnswers({});
    setOtherOpen(false);
    setOtherDraft("");
    setReviewing(false);
  }

  if (!envelope || envelope.questions.length === 0) return null;

  const question = envelope.questions[index] ?? envelope.questions[0];
  if (!question) return null;

  const many = envelope.questions.length > 1;
  const current = answers[question.id];
  const currentDone = isQuestionAnswered(question, current);
  const allDone = isAllQuestionsAnswered(envelope, answers);

  const updateAnswer = (next: QuestionAnswerItem) => {
    setAnswers((prev) => ({ ...prev, [next.id]: next }));
  };

  const handleCancel = () => {
    onAnswer(requestId, { cancelled: true });
  };

  const handleSubmitAll = () => {
    if (!allDone) return;
    const ordered = envelope.questions
      .map((q) => answers[q.id])
      .filter((item): item is QuestionAnswerItem => item !== undefined);
    onAnswer(requestId, { value: serializeQuestionResponse(ordered, false) });
  };

  const handleAdvance = () => {
    if (!currentDone) return;
    if (index < envelope.questions.length - 1) {
      setIndex(index + 1);
      setOtherOpen(false);
      setOtherDraft("");
      return;
    }
    if (envelope.review && many) {
      setReviewing(true);
      return;
    }
    handleSubmitAll();
  };

  const toggleMultiOption = (target: QuestionItem, optValue: string, optLabel: string) => {
    const existing = answers[target.id];
    const prevValues = Array.isArray(existing?.value) ? [...existing.value] : [];
    const prevLabels = Array.isArray(existing?.labels) ? [...existing.labels] : [...prevValues];
    const pos = prevValues.indexOf(optValue);
    if (pos >= 0) {
      prevValues.splice(pos, 1);
      prevLabels.splice(pos, 1);
    } else {
      prevValues.push(optValue);
      prevLabels.push(optLabel);
    }
    updateAnswer({
      id: target.id,
      question: target.question,
      type: target.type,
      value: prevValues,
      values: prevValues,
      labels: prevLabels,
      label: prevLabels.join("、"),
    });
  };

  const selectSingleOption = (target: QuestionItem, optValue: string, optLabel: string) => {
    if (optValue === OTHER_OPTION_VALUE) {
      setOtherOpen(true);
      return;
    }
    setOtherOpen(false);
    if (target.type === "confirm") {
      updateAnswer({
        id: target.id,
        question: target.question,
        type: "confirm",
        value: optValue === "yes",
        label: optLabel,
      });
      return;
    }
    if (target.multiple) {
      toggleMultiOption(target, optValue, optLabel);
      return;
    }
    updateAnswer({
      id: target.id,
      question: target.question,
      type: target.type,
      value: optValue,
      label: optLabel,
      wasCustom: false,
    });
  };

  const commitCustomOther = () => {
    const trimmed = otherDraft.trim();
    if (trimmed === "") return;
    if (question.multiple) {
      toggleMultiOption(question, trimmed, trimmed);
      setOtherDraft("");
      setOtherOpen(false);
      return;
    }
    updateAnswer({
      id: question.id,
      question: question.question,
      type: question.type,
      value: trimmed,
      label: trimmed,
      wasCustom: true,
    });
    setOtherOpen(false);
  };

  const optionRows =
    question.type === "confirm"
      ? [
          { label: "是", value: "yes", description: undefined, recommended: false },
          { label: "否", value: "no", description: undefined, recommended: false },
        ]
      : [
          ...(question.options ?? []),
          ...(question.allowOther !== false
            ? [{ label: "其他 / 自行补充…", value: OTHER_OPTION_VALUE, description: "输入自定义答案", recommended: false }]
            : []),
        ];

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleCancel();
      return;
    }
    if (reviewing || otherOpen || event.altKey || event.ctrlKey || event.metaKey) return;
    if (question.type === "select" || question.type === "confirm") {
      const idx = Number(event.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < Math.min(optionRows.length, 9)) {
        const picked = optionRows[idx];
        if (picked) {
          event.preventDefault();
          selectSingleOption(question, picked.value, picked.label);
        }
      }
    }
  };

  const headline =
    envelope.title ?? (many ? `需要你的回答（${index + 1}/${envelope.questions.length}）` : "需要你的回答");

  return (
    <section
      className="qj-question-card"
      data-qj-plugin="question"
      data-question-dialog=""
      role="dialog"
      aria-label={headline}
      onKeyDown={handleCardKeyDown}
    >
      <header className="qj-question-head">
        <span className="qj-question-badge">
          <CircleHelp size={13.5} />
          <span>{headline}</span>
        </span>
        <span className="qj-question-shortcut">
          {reviewing
            ? "确认无误后提交"
            : question.type === "select" || question.type === "confirm"
              ? "1-9 快捷选择 · Esc 取消"
              : "Esc 取消"}
        </span>
      </header>

      {many && (
        <div className="qj-question-tabs" role="tablist">
          {envelope.questions.map((item, tabIdx) => {
            const done = isQuestionAnswered(item, answers[item.id]);
            const active = !reviewing && tabIdx === index;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`qj-question-tab${active ? " is-active" : ""}${done ? " is-done" : ""}`}
                onClick={() => {
                  setReviewing(false);
                  setIndex(tabIdx);
                  setOtherOpen(false);
                }}
              >
                {done && <Check size={11} />}
                <span>{item.header ?? `问题 ${tabIdx + 1}`}</span>
              </button>
            );
          })}
          {envelope.review && (
            <button
              type="button"
              role="tab"
              aria-selected={reviewing}
              disabled={!allDone}
              className={`qj-question-tab${reviewing ? " is-active" : ""}`}
              onClick={() => {
                if (allDone) setReviewing(true);
              }}
            >
              <span>审阅提交</span>
            </button>
          )}
        </div>
      )}

      {reviewing ? (
        <>
          <div className="qj-question-title-row">
            <h2 className="qj-question-title">确认全部回答</h2>
          </div>
          <ul className="qj-question-review-list">
            {envelope.questions.map((item, itemIdx) => (
              <li
                key={item.id}
                className="qj-question-review-item"
                onClick={() => {
                  setReviewing(false);
                  setIndex(itemIdx);
                }}
                style={{ cursor: "pointer" }}
                title="点击返回修改此题"
              >
                <span className="qj-question-review-q">{item.question}</span>
                <span className="qj-question-review-a">{formatAnswerDisplay(item, answers[item.id])}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="qj-question-title-row">
            <h2 className="qj-question-title">{question.question}</h2>
            {question.multiple && <span className="qj-question-mode-pill">可多选</span>}
          </div>

          {(question.type === "select" || question.type === "confirm") && (
            <div
              className="qj-question-options"
              role={question.multiple ? "group" : "radiogroup"}
              aria-label={question.question}
            >
              {optionRows.map((opt, optIdx) => {
                const isActive = (() => {
                  if (opt.value === OTHER_OPTION_VALUE) {
                    return otherOpen || Boolean(!question.multiple && current?.wasCustom);
                  }
                  if (question.type === "confirm") {
                    return (opt.value === "yes" && current?.value === true) || (opt.value === "no" && current?.value === false);
                  }
                  if (question.multiple) {
                    return Array.isArray(current?.value) && current.value.includes(opt.value);
                  }
                  return !current?.wasCustom && current?.value === opt.value;
                })();

                return (
                  <button
                    key={`${opt.value}-${optIdx}`}
                    type="button"
                    role={question.multiple ? "checkbox" : "radio"}
                    aria-checked={isActive}
                    className={`qj-question-option${isActive ? " is-active" : ""}`}
                    onClick={() => selectSingleOption(question, opt.value, opt.label)}
                    onDoubleClick={() => {
                      if (!question.multiple && opt.value !== OTHER_OPTION_VALUE && !many) {
                        const directAns: QuestionAnswerItem = {
                          id: question.id,
                          question: question.question,
                          type: question.type,
                          value: question.type === "confirm" ? opt.value === "yes" : opt.value,
                          label: opt.label,
                        };
                        onAnswer(requestId, { value: serializeQuestionResponse([directAns], false) });
                      }
                    }}
                  >
                    <span className={`qj-question-indicator${question.multiple ? " is-multi" : ""}`}>
                      {isActive && <Check size={11} strokeWidth={2.6} />}
                    </span>
                    <span className="qj-question-opt-body">
                      <span className="qj-question-opt-head">
                        <span className="qj-question-opt-label">{opt.label}</span>
                        {opt.recommended && <span className="qj-question-rec-pill">推荐</span>}
                      </span>
                      {opt.description && <span className="qj-question-opt-desc">{opt.description}</span>}
                    </span>
                    {optIdx < 9 && <span className="qj-question-kbd">{optIdx + 1}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {(question.type === "input" || otherOpen) && (
            <input
              type="text"
              className="qj-question-field"
              value={
                otherOpen
                  ? otherDraft
                  : typeof current?.value === "string"
                    ? current.value
                    : (question.prefill ?? "")
              }
              placeholder={question.placeholder ?? (otherOpen ? "输入自定义补充回答…" : "请输入回答…")}
              onChange={(e) => {
                if (otherOpen) {
                  setOtherDraft(e.target.value);
                  return;
                }
                updateAnswer({
                  id: question.id,
                  question: question.question,
                  type: "input",
                  value: e.target.value,
                  label: e.target.value,
                });
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent?.isComposing) return;
                e.preventDefault();
                if (otherOpen) commitCustomOther();
                else handleAdvance();
              }}
            />
          )}

          {question.type === "editor" && (
            <textarea
              className="qj-question-field"
              rows={5}
              value={typeof current?.value === "string" ? current.value : (question.prefill ?? "")}
              placeholder={question.placeholder ?? "请输入详细说明…"}
              onChange={(e) =>
                updateAnswer({
                  id: question.id,
                  question: question.question,
                  type: "editor",
                  value: e.target.value,
                  label: e.target.value,
                })
              }
            />
          )}

          {otherOpen && (
            <div className="qj-question-other-bar">
              <button type="button" className="qj-q-btn" onClick={() => setOtherOpen(false)}>
                收起补充框
              </button>
              <button
                type="button"
                className="qj-q-btn is-primary"
                disabled={otherDraft.trim() === ""}
                onClick={commitCustomOther}
              >
                <Check size={13} />
                <span>确认自定义答案</span>
              </button>
            </div>
          )}
        </>
      )}

      <footer className="qj-question-footer">
        <button type="button" className="qj-q-btn" onClick={handleCancel}>
          <X size={13.5} />
          <span>跳过提问</span>
        </button>

        <div className="qj-question-footer-right">
          {many && (reviewing || index > 0) && (
            <button
              type="button"
              className="qj-q-btn"
              onClick={() => {
                if (reviewing) {
                  setReviewing(false);
                } else {
                  setIndex(Math.max(0, index - 1));
                  setOtherOpen(false);
                }
              }}
            >
              <ArrowLeft size={13.5} />
              <span>上一题</span>
            </button>
          )}

          {!reviewing && many && (index < envelope.questions.length - 1 || envelope.review) ? (
            <button
              type="button"
              className="qj-q-btn is-primary"
              disabled={!currentDone}
              onClick={handleAdvance}
            >
              <span>{index < envelope.questions.length - 1 ? "下一题" : "审阅答案"}</span>
              <ArrowRight size={13.5} />
            </button>
          ) : (
            <button
              type="button"
              className="qj-q-btn is-primary"
              disabled={!allDone}
              onClick={handleSubmitAll}
            >
              <Check size={13.5} />
              <span>提交回答</span>
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

export function QuestionToolCallCard({ call, state }: ToolCallProps) {
  const [expanded, setExpanded] = useState(true);
  const rawArgs = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>;
  const parsedArgs = normalizeQuestionnaireInput(rawArgs, { maxQuestions: 12 });
  const parsedResult = parseQuestionResultPayload(call.result);

  const count = parsedResult?.answers.length ?? parsedArgs?.questions.length ?? 1;
  const titleText =
    parsedResult?.title ??
    parsedArgs?.title ??
    (count > 1 ? `追问了 ${count} 个问题` : (parsedArgs?.questions[0]?.question ?? "向你发起追问"));

  const statusBadge =
    state === "running"
      ? { label: "等待回答…", cls: "is-running" }
      : parsedResult?.status === "cancelled"
        ? { label: "已跳过", cls: "is-muted" }
        : parsedResult?.status === "unattended"
          ? { label: "默认处理", cls: "is-muted" }
          : state === "error"
            ? { label: "未完成", cls: "is-muted" }
            : { label: "已回答", cls: "" };

  const rows =
    parsedResult?.answers ??
    (parsedArgs?.questions ?? []).map((q) => ({
      id: q.id,
      question: q.question,
      display: state === "running" ? "等待选择…" : "—",
    }));

  return (
    <div className="qj-question-tool-card" data-qj-plugin="question" data-tool-card="question">
      <button
        type="button"
        className="qj-question-tool-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="qj-question-tool-title">
          {state === "running" ? <LoaderCircle size={13} /> : <CircleHelp size={13.5} />}
          <span>{titleText}</span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <span className={`qj-question-tool-status ${statusBadge.cls}`}>{statusBadge.label}</span>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {expanded && rows.length > 0 && (
        <div className="qj-question-tool-rows">
          {rows.map((row) => (
            <div key={row.id} className="qj-question-tool-row">
              <span className="qj-question-tool-q">{row.question}</span>
              <span className="qj-question-tool-a">{row.display}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function apply(ctx: Context): void {
  ctx.styles.inject(QUESTION_SCOPED_CSS, "question:styles");

  ctx.slots.register<"conversation.approvalDialog", unknown, QuestionEnvelope>(
    "conversation.approvalDialog",
    {
      id: "question:approval-dialog",
      priority: 30,
      select: (props) => parseQuestionEnvelopeFromRequest(props.request) ?? false,
      component: QuestionApprovalCard,
    },
  );

  ctx.slots.register("conversation.toolCall", {
    id: "question:tool-call",
    key: ["question", "ask_question"],
    priority: 20,
    component: QuestionToolCallCard,
  });
}

export default {
  name,
  inject,
  apply,
};
