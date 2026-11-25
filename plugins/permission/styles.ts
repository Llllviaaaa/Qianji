export const PERMISSION_SCOPED_CSS = `
.qj-perm-card {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 14px 16px;
  margin: 10px 0;
  border-radius: var(--qj-radius-lg, 12px);
  border: 1px solid color-mix(in srgb, var(--qj-status-warning) 36%, var(--qj-border-default));
  background: var(--qj-bg-surface);
  color: var(--qj-text-primary);
  font-family: var(--qj-font-sans);
  box-shadow: var(--qj-shadow-md, 0 6px 20px rgba(0, 0, 0, 0.08));
}

.qj-perm-card.is-high {
  border-color: color-mix(in srgb, var(--qj-status-danger) 46%, var(--qj-border-default));
}

.qj-perm-card.is-low {
  border-color: color-mix(in srgb, var(--qj-brand-primary) 30%, var(--qj-border-default));
}

.qj-perm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.qj-perm-head-left {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.qj-perm-kind-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 9999px;
  font-size: 11.5px;
  font-weight: 600;
  background: color-mix(in srgb, var(--qj-status-warning) 15%, transparent);
  color: var(--qj-status-warning);
}

.qj-perm-card.is-high .qj-perm-kind-badge {
  background: color-mix(in srgb, var(--qj-status-danger) 15%, transparent);
  color: var(--qj-status-danger);
}

.qj-perm-risk-pill {
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  color: var(--qj-text-secondary);
}

.qj-perm-risk-pill.is-high {
  border-color: color-mix(in srgb, var(--qj-status-danger) 42%, var(--qj-border-default));
  color: var(--qj-status-danger);
}

.qj-perm-risk-pill.is-low {
  border-color: color-mix(in srgb, var(--qj-status-success) 38%, var(--qj-border-default));
  color: var(--qj-status-success);
}

.qj-perm-shortcut {
  font-size: 11.5px;
  color: var(--qj-text-tertiary, var(--qj-text-secondary));
}

.qj-perm-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--qj-text-primary);
}

.qj-perm-meta-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.qj-perm-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--qj-bg-subtle);
  border: 1px solid var(--qj-border-default);
  color: var(--qj-text-secondary);
  font-family: var(--qj-font-mono);
  font-size: 11.5px;
}

.qj-perm-reason {
  padding: 8px 11px;
  border-radius: var(--qj-radius-sm, 7px);
  background: color-mix(in srgb, var(--qj-brand-primary) 7%, var(--qj-bg-subtle));
  border-left: 3px solid var(--qj-brand-primary);
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--qj-text-primary);
}

.qj-perm-codebox {
  margin: 0;
  padding: 9px 12px;
  border-radius: var(--qj-radius-sm, 7px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-app, var(--qj-bg-subtle));
  color: var(--qj-text-primary);
  font-family: var(--qj-font-mono);
  font-size: 12px;
  line-height: 1.5;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.qj-perm-diff {
  border-radius: var(--qj-radius-sm, 7px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-app, var(--qj-bg-subtle));
  font-family: var(--qj-font-mono);
  font-size: 11.5px;
  line-height: 1.45;
  max-height: 220px;
  overflow: auto;
  padding: 6px 0;
}

.qj-perm-diff-line {
  padding: 0 10px;
  white-space: pre-wrap;
  word-break: break-all;
}

.qj-perm-diff-line.is-add {
  background: color-mix(in srgb, var(--qj-status-success) 14%, transparent);
  color: var(--qj-status-success);
}

.qj-perm-diff-line.is-del {
  background: color-mix(in srgb, var(--qj-status-danger) 14%, transparent);
  color: var(--qj-status-danger);
}

.qj-perm-diff-line.is-meta {
  color: var(--qj-text-secondary);
}

.qj-perm-scope-hint {
  font-size: 11.5px;
  color: var(--qj-text-secondary);
}

.qj-perm-feedback-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.qj-perm-feedback-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border-radius: var(--qj-radius-sm, 7px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-app, var(--qj-bg-subtle));
  color: var(--qj-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  outline: none;
}

.qj-perm-feedback-input:focus {
  border-color: var(--qj-status-warning);
}

.qj-perm-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.qj-perm-footer-left,
.qj-perm-footer-right {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.qj-perm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 11px;
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

.qj-perm-btn:hover:not(:disabled) {
  background: var(--qj-bg-hover);
}

.qj-perm-btn.is-ghost {
  background: transparent;
  color: var(--qj-text-secondary);
}

.qj-perm-btn.is-danger {
  border-color: color-mix(in srgb, var(--qj-status-danger) 38%, var(--qj-border-default));
  color: var(--qj-status-danger);
}

.qj-perm-btn.is-session {
  border-color: color-mix(in srgb, var(--qj-brand-primary) 42%, var(--qj-border-default));
  background: color-mix(in srgb, var(--qj-brand-primary) 10%, var(--qj-bg-surface));
  color: var(--qj-brand-primary);
}

.qj-perm-btn.is-primary {
  border-color: var(--qj-brand-primary);
  background: var(--qj-brand-primary);
  color: #fff;
}

.qj-perm-btn.is-primary:hover:not(:disabled) {
  opacity: 0.92;
}

/* Inline request_permission tool card */
.qj-perm-tool-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  margin: 4px 0;
  border-radius: var(--qj-radius-md, 9px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  font-family: var(--qj-font-sans);
  font-size: 12.5px;
}

.qj-perm-tool-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.qj-perm-tool-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--qj-text-primary);
}

.qj-perm-tool-pill {
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--qj-status-success) 15%, transparent);
  color: var(--qj-status-success);
}

.qj-perm-tool-pill.is-denied {
  background: color-mix(in srgb, var(--qj-status-danger) 15%, transparent);
  color: var(--qj-status-danger);
}

.qj-perm-tool-pill.is-running {
  background: color-mix(in srgb, var(--qj-brand-primary) 15%, transparent);
  color: var(--qj-brand-primary);
}

/* Settings grants manager */
.qj-perm-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--qj-radius-md, 10px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-surface);
  font-family: var(--qj-font-sans);
}

.qj-perm-settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.qj-perm-rule-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.qj-perm-rule-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: var(--qj-radius-sm, 7px);
  border: 1px solid var(--qj-border-default);
  background: var(--qj-bg-subtle);
  font-size: 12px;
}
`;
