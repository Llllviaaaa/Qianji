/**
 * Serialized, race-free settings form hook shared by host settings factories
 * (`src/kernel/primitives/hostSettingsForm.ts`).
 *
 * Preserves local draft responsiveness while coalescing synchronous multi-field
 * `update()` batches and keeping `useAppStore.getState().settings` untouched
 * until `saveSettings(next)` runs so `runtime.ts` detects `prevSettings` diffs
 * (e.g. live model thinking-level sync) and reports save failures via toast.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULTS } from "../../components/settings/settingsPrimitives";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { describeError } from "../../lib/errors";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";

export function useLiveAppSettingsForm(): {
  form: AppSettings;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
} {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [form, setForm] = useState<AppSettings>(() => ({
    ...DEFAULTS,
    ...settings,
    language: "zh-CN",
  }));

  const formRef = useRef<AppSettings>(form);
  const pendingRef = useRef<AppSettings | null>(null);
  const inFlightRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useSyncOnChange([settings], () => {
    // Only pull store updates into local form when no local edit is pending/in-flight.
    if (pendingRef.current === null && !inFlightRef.current) {
      const merged: AppSettings = { ...DEFAULTS, ...settings, language: "zh-CN" };
      formRef.current = merged;
      setForm(merged);
    }
  });

  const drainQueue = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      while (pendingRef.current !== null) {
        const snapshot = pendingRef.current;
        pendingRef.current = null;
        try {
          await saveSettings(snapshot);
        } catch (error) {
          useAppStore.getState().showToast(`保存设置失败：${describeError(error)}`, "error");
        }
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && pendingRef.current === null) {
        const latest = useAppStore.getState().settings;
        const synced: AppSettings = { ...DEFAULTS, ...latest, language: "zh-CN" };
        formRef.current = synced;
        setForm(synced);
      }
    }
  }, [saveSettings]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        if (pendingRef.current !== null) {
          void drainQueue();
        }
      }
    };
  }, [drainQueue]);

  const update = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      const base = pendingRef.current ?? formRef.current;
      const next: AppSettings = { ...DEFAULTS, ...base, [key]: value, language: "zh-CN" };
      formRef.current = next;
      pendingRef.current = next;
      setForm(next);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
      }
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        void drainQueue();
      }, 60);
    },
    [drainQueue],
  );

  return { form, update };
}
