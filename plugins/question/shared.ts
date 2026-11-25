export const QUESTION_ENVELOPE_KEY = "__qianjiQuestion";
export const QUESTION_PLACEHOLDER = "__qianjiQuestion__";
export const LEGACY_BATCH_ASK_KEY = "__piDeckBatchAsk";
export const LEGACY_BATCH_ASK_PLACEHOLDER = "__piDeckBatchAsk__";
export const QUESTION_NAMESPACE = "qianji-question";

export type QuestionKind = "select" | "confirm" | "input" | "editor";

export interface QuestionOption {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
}

export interface QuestionItem {
  id: string;
  header?: string;
  type: QuestionKind;
  question: string;
  multiple?: boolean;
  options?: QuestionOption[];
  allowOther?: boolean;
  placeholder?: string;
  prefill?: string;
}

export interface QuestionEnvelope {
  title?: string;
  questions: QuestionItem[];
  review: boolean;
}

export interface QuestionAnswerItem {
  id: string;
  question?: string;
  type: QuestionKind;
  value: string | string[] | boolean | null;
  label?: string;
  values?: string[];
  labels?: string[];
  wasCustom?: boolean;
  note?: string;
}

export interface QuestionResponsePayload {
  cancelled?: boolean;
  answers: QuestionAnswerItem[];
}

export interface QuestionResultPayload {
  status: "answered" | "cancelled" | "unattended";
  title?: string;
  answers: Array<{
    id: string;
    header?: string;
    question: string;
    answer: string | string[] | boolean | null;
    display: string;
    wasCustom?: boolean;
    note?: string;
  }>;
  message?: string;
}

export interface QuestionHistoryRecord extends QuestionResultPayload {
  id: string;
  createdAt: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RECOMMENDED_PREFIX_RE = /^(?:\(\s*recommended\s*\)|（\s*推荐\s*）|\[\s*推荐\s*\]|\[\s*recommended\s*\])\s*/i;

export function stripRecommendedPrefix(rawLabel: string): { label: string; detectedRecommended: boolean } {
  const trimmed = rawLabel.trim();
  if (RECOMMENDED_PREFIX_RE.test(trimmed)) {
    const cleaned = trimmed.replace(RECOMMENDED_PREFIX_RE, "").trim();
    return { label: cleaned || trimmed, detectedRecommended: true };
  }
  return { label: trimmed, detectedRecommended: false };
}

export function normalizeQuestionOptions(rawOptions: unknown): QuestionOption[] {
  if (!Array.isArray(rawOptions)) return [];
  const normalized: QuestionOption[] = [];
  for (const item of rawOptions) {
    if (typeof item === "string") {
      const { label, detectedRecommended } = stripRecommendedPrefix(item);
      if (label !== "") {
        normalized.push({
          label,
          value: label,
          ...(detectedRecommended ? { recommended: true } : {}),
        });
      }
      continue;
    }
    if (!isRecord(item)) continue;
    const rawLabel = typeof item.label === "string" ? item.label : typeof item.value === "string" ? item.value : "";
    const { label, detectedRecommended } = stripRecommendedPrefix(rawLabel);
    const rawValue = typeof item.value === "string" && item.value.trim() !== "" ? item.value.trim() : label;
    if (label === "" && rawValue === "") continue;
    const description =
      typeof item.description === "string" && item.description.trim() !== "" ? item.description.trim() : undefined;
    const recommended = item.recommended === true || detectedRecommended;
    normalized.push({
      label: label || rawValue,
      value: rawValue || label,
      ...(description === undefined ? {} : { description }),
      ...(recommended ? { recommended: true } : {}),
    });
  }
  return normalized;
}

export function normalizeQuestionKind(rawType: unknown, hasOptions: boolean): QuestionKind {
  if (rawType === "select" || rawType === "confirm" || rawType === "input" || rawType === "editor") {
    if (rawType === "select" && !hasOptions) return "input";
    return rawType;
  }
  return hasOptions ? "select" : "input";
}

export interface NormalizeQuestionsOptions {
  maxQuestions?: number;
  allowCustomAnswerByDefault?: boolean;
  defaultReview?: boolean;
}

export function normalizeQuestionnaireInput(
  rawArgs: Record<string, unknown>,
  opts: NormalizeQuestionsOptions = {},
): QuestionEnvelope | null {
  const maxQuestions = Math.max(1, Math.min(12, Math.floor(opts.maxQuestions ?? 6)));
  const allowCustomDefault = opts.allowCustomAnswerByDefault !== false;
  const rawList = Array.isArray(rawArgs.questions)
    ? rawArgs.questions
    : typeof rawArgs.question === "string" && rawArgs.question.trim() !== ""
      ? [rawArgs]
      : [];

  const questions: QuestionItem[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < rawList.length && questions.length < maxQuestions; index += 1) {
    const raw = rawList[index];
    if (!isRecord(raw)) continue;
    const questionText = typeof raw.question === "string" ? raw.question.trim() : "";
    if (questionText === "") continue;
    const options = normalizeQuestionOptions(raw.options);
    const type = normalizeQuestionKind(raw.type, options.length > 0);
    let id = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : `q${questions.length + 1}`;
    if (usedIds.has(id)) {
      id = `${id}_${questions.length + 1}`;
    }
    usedIds.add(id);

    const header =
      typeof raw.header === "string" && raw.header.trim() !== ""
        ? raw.header.trim().slice(0, 20)
        : undefined;
    const multiple = type === "select" && (raw.multiple === true || raw.is_multi_select === true || raw.multiSelect === true);
    const allowOther =
      type === "select"
        ? typeof raw.allowOther === "boolean"
          ? raw.allowOther
          : typeof raw.custom === "boolean"
            ? raw.custom
            : allowCustomDefault
        : undefined;
    const placeholder =
      typeof raw.placeholder === "string" && raw.placeholder.trim() !== "" ? raw.placeholder.trim() : undefined;
    const prefill = typeof raw.prefill === "string" ? raw.prefill : undefined;

    questions.push({
      id,
      ...(header === undefined ? {} : { header }),
      type,
      question: questionText,
      ...(multiple ? { multiple: true } : {}),
      ...(type === "select" ? { options } : {}),
      ...(allowOther === undefined ? {} : { allowOther }),
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(prefill === undefined ? {} : { prefill }),
    });
  }

  if (questions.length === 0) return null;

  const title = typeof rawArgs.title === "string" && rawArgs.title.trim() !== "" ? rawArgs.title.trim() : undefined;
  const review =
    typeof rawArgs.review === "boolean"
      ? rawArgs.review
      : (opts.defaultReview !== false && questions.length > 1);

  return {
    ...(title === undefined ? {} : { title }),
    questions,
    review,
  };
}

export function serializeQuestionEnvelope(envelope: QuestionEnvelope): string {
  return JSON.stringify({
    [QUESTION_ENVELOPE_KEY]: 1,
    ...(envelope.title === undefined ? {} : { title: envelope.title }),
    questions: envelope.questions,
    review: envelope.review,
  });
}

export function parseQuestionEnvelopeFromRequest(request: Record<string, unknown>): QuestionEnvelope | null {
  if (request.method !== "input") return null;
  const title = typeof request.title === "string" ? request.title : "";
  const placeholder = typeof request.placeholder === "string" ? request.placeholder : "";
  const looksLike =
    placeholder === QUESTION_PLACEHOLDER ||
    placeholder === LEGACY_BATCH_ASK_PLACEHOLDER ||
    title.includes(QUESTION_ENVELOPE_KEY) ||
    title.includes(LEGACY_BATCH_ASK_KEY);
  if (!looksLike) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(title);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    (parsed[QUESTION_ENVELOPE_KEY] !== 1 && parsed[LEGACY_BATCH_ASK_KEY] !== 1)
  ) {
    return null;
  }
  return normalizeQuestionnaireInput(parsed, {
    maxQuestions: 12,
    allowCustomAnswerByDefault: true,
    defaultReview: parsed.review === true,
  });
}

export function serializeQuestionResponse(answers: QuestionAnswerItem[], cancelled = false): string {
  const payload: QuestionResponsePayload = cancelled ? { cancelled: true, answers } : { answers };
  return JSON.stringify(payload);
}

export function parseQuestionResponse(raw: unknown): QuestionResponsePayload | null {
  if (raw === undefined || raw === null) return { cancelled: true, answers: [] };
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return { cancelled: true, answers: [] };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    const answers = Array.isArray(parsed.answers)
      ? parsed.answers.filter((item): item is QuestionAnswerItem => isRecord(item) && typeof item.id === "string")
      : [];
    return {
      cancelled: parsed.cancelled === true,
      answers,
    };
  } catch {
    return null;
  }
}

export function isQuestionAnswered(question: QuestionItem, answer: QuestionAnswerItem | undefined): boolean {
  if (answer === undefined || answer.value === null || answer.value === undefined) return false;
  if (question.type === "confirm") return typeof answer.value === "boolean";
  if (question.multiple) {
    return Array.isArray(answer.value) && answer.value.length > 0;
  }
  if (Array.isArray(answer.value)) return answer.value.length > 0;
  return String(answer.value).trim() !== "";
}

export function isAllQuestionsAnswered(
  envelope: QuestionEnvelope,
  answers: Readonly<Record<string, QuestionAnswerItem>>,
): boolean {
  return envelope.questions.every((q) => isQuestionAnswered(q, answers[q.id]));
}

export function formatAnswerDisplay(question: QuestionItem, answer: QuestionAnswerItem | undefined): string {
  if (answer === undefined || answer.value === null || answer.value === undefined) return "未回答";
  if (question.type === "confirm") {
    return answer.value === true ? "是" : "否";
  }
  if (Array.isArray(answer.labels) && answer.labels.length > 0) {
    return answer.labels.join("、");
  }
  if (Array.isArray(answer.value)) {
    return answer.value.join("、");
  }
  if (typeof answer.label === "string" && answer.label.trim() !== "") {
    return answer.label.trim();
  }
  return String(answer.value);
}

export function parseQuestionResultPayload(rawResult: unknown): QuestionResultPayload | null {
  if (typeof rawResult !== "string" || rawResult.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(rawResult);
    if (!isRecord(parsed) || typeof parsed.status !== "string" || !Array.isArray(parsed.answers)) {
      return null;
    }
    if (parsed.status !== "answered" && parsed.status !== "cancelled" && parsed.status !== "unattended") {
      return null;
    }
    return parsed as unknown as QuestionResultPayload;
  } catch {
    return null;
  }
}
