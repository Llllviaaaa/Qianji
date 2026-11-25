export const QUESTION_SCOPED_CSS = `
.qj-question-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  margin: 10px 0;
  border-radius: var(--qj-radius-lg, 12px);
  border: 1px solid color-mix(in srgb, var(--qj-brand-primary) 28%, var(--qj-border-default));
  background: var(--qj-bg-surface);
  color: var(--qj-text-primary);
  font-family: var(--qj-font-sans);
  box-shadow: var(--qj-shadow-md, 0 6px 20px rgba(0, 0, 0, 0.08));
}

.qj-question-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.qj-question-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 9999px;
  font-size: 11.5px;
  font-weight: 600;
  background: color-mix(in srgb, var(--qj-brand-primary) 13%, transparent);
  color: var(--qj-brand-primary);
}

.qj-question-shortcut {
  font-size: 11.5px;
  color: var(--qj-text-tertiary, var(--qj-text-secondary));
  font-variant-numeric: tabular-nums;
}

.qj-question-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--qj-border-subtle, var(--qj-border-default));
}

.qj-question-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 9999px;
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  color: var(--qj-text-secondary);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 550;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
}

.qj-question-tab:hover:not(:disabled) {
  background: var(--qj-bg-hover);
  color: var(--qj-text-primary);
}

.qj-question-tab.is-active {
  border-color: var(--qj-brand-primary);
  background: color-mix(in srgb, var(--qj-brand-primary) 12%, var(--qj-bg-surface));
  color: var(--qj-brand-primary);
}

.qj-question-tab.is-done:not(.is-active) {
  border-color: color-mix(in srgb, var(--qj-status-success) 40%, var(--qj-border-default));
  color: var(--qj-status-success);
}

.qj-question-tab:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.qj-question-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.qj-question-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--qj-text-primary);
}

.qj-question-mode-pill {
  padding: 2px 7px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 550;
  background: var(--qj-bg-subtle);
  color: var(--qj-text-secondary);
  border: 1px solid var(--qj-border-default);
  white-space: nowrap;
}

.qj-question-options {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.qj-question-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-radius: var(--qj-radius-md, 9px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  color: var(--qj-text-primary);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 130ms ease, border-color 130ms ease;
}

.qj-question-option:hover {
  background: var(--qj-bg-hover);
}

.qj-question-option.is-active {
  border-color: var(--qj-brand-primary);
  background: color-mix(in srgb, var(--qj-brand-primary) 9%, var(--qj-bg-surface));
}

.qj-question-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border-radius: 9999px;
  border: 1.5px solid var(--qj-border-strong, var(--qj-border-default));
  background: var(--qj-bg-surface);
  color: #fff;
  flex-shrink: 0;
}

.qj-question-indicator.is-multi {
  border-radius: 4px;
}

.qj-question-option.is-active .qj-question-indicator {
  border-color: var(--qj-brand-primary);
  background: var(--qj-brand-primary);
}

.qj-question-opt-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}

.qj-question-opt-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.qj-question-opt-label {
  font-weight: 550;
  line-height: 1.35;
}

.qj-question-rec-pill {
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 10.5px;
  font-weight: 600;
  background: color-mix(in srgb, var(--qj-status-success) 15%, transparent);
  color: var(--qj-status-success);
}

.qj-question-opt-desc {
  font-size: 12px;
  color: var(--qj-text-secondary);
  line-height: 1.4;
}

.qj-question-kbd {
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  color: var(--qj-text-tertiary, var(--qj-text-secondary));
  font-family: var(--qj-font-mono);
  font-size: 11px;
  flex-shrink: 0;
}

.qj-question-field {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 11px;
  border-radius: var(--qj-radius-sm, 7px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-app, var(--qj-bg-subtle));
  color: var(--qj-text-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  outline: none;
}

.qj-question-field:focus {
  border-color: var(--qj-brand-primary);
}

.qj-question-other-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.qj-question-review-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.qj-question-review-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 11px;
  border-radius: var(--qj-radius-sm, 7px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  font-size: 12.5px;
}

.qj-question-review-q {
  color: var(--qj-text-secondary);
  flex: 1 1 55%;
}

.qj-question-review-a {
  font-weight: 600;
  color: var(--qj-text-primary);
  text-align: right;
  flex: 1 1 40%;
}

.qj-question-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 4px;
}

.qj-question-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.qj-q-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--qj-radius-sm, 7px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  color: var(--qj-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
  transition: background-color 130ms ease, border-color 130ms ease, opacity 130ms ease;
}

.qj-q-btn:hover:not(:disabled) {
  background: var(--qj-bg-hover);
}

.qj-q-btn.is-primary {
  border-color: var(--qj-brand-primary);
  background: var(--qj-brand-primary);
  color: #fff;
}

.qj-q-btn.is-primary:hover:not(:disabled) {
  opacity: 0.92;
}

.qj-q-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Inline conversation.toolCall summary card */
.qj-question-tool-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px;
  margin: 4px 0;
  border-radius: var(--qj-radius-md, 9px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  font-family: var(--qj-font-sans);
  font-size: 12.5px;
}

.qj-question-tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
  width: 100%;
  text-align: left;
  color: var(--qj-text-primary);
  font-family: inherit;
  font-size: 12.5px;
}

.qj-question-tool-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.qj-question-tool-status {
  padding: 1px 7px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  background: color-mix(in srgb, var(--qj-status-success) 14%, transparent);
  color: var(--qj-status-success);
}

.qj-question-tool-status.is-running {
  background: color-mix(in srgb, var(--qj-brand-primary) 14%, transparent);
  color: var(--qj-brand-primary);
}

.qj-question-tool-status.is-muted {
  background: color-mix(in srgb, var(--qj-text-secondary) 14%, transparent);
  color: var(--qj-text-secondary);
}

.qj-question-tool-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 4px;
  border-top: 1px solid var(--qj-border-subtle, var(--qj-border-default));
}

.qj-question-tool-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  line-height: 1.4;
}

.qj-question-tool-q {
  color: var(--qj-text-secondary);
  min-width: 0;
  flex: 1 1 auto;
}

.qj-question-tool-a {
  font-weight: 600;
  color: var(--qj-text-primary);
  flex-shrink: 0;
  max-width: 55%;
  text-align: right;
  word-break: break-word;
}
`;
