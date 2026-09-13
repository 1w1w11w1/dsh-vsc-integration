import React, { useEffect, useState } from "react";
import { postAction } from "../bridge";
import { t } from "../i18n";
import type { StatusBannerState } from "../state";
import { CloseIcon } from "./icons";

const ACTION_LABELS = {
    cancelRecovery: "Cancel recovery",
    openLogs: "View details",
    restoreRecovery: "Restore",
    exportRecoveryDiagnostics: "Export diagnostics",
    start: "Retry",
} as const;

export function StatusBanner({ status, sessionStatus }: StatusBannerState): React.JSX.Element | null {
    const recovery = status.recovery;
    const recovering = status.state === "recovering";
    const recovered = recovery?.phase === "recovered" && status.state === "running" && !sessionStatus?.error;
    const runtimeError = status.state === "error" ? status.message : undefined;
    const sessionError = sessionStatus?.error;
    const message = sessionError || runtimeError;
    const messageKey = message
        ? `${sessionError ? "session" : "runtime"}:${message}:${recovery?.phase ?? ""}`
        : recovery?.sessionId
            ? `recovery:${recovery.sessionId}:${recovery.phase}`
            : undefined;
    const [dismissedKey, setDismissedKey] = useState<string>();

    useEffect(() => {
        setDismissedKey(undefined);
    }, [messageKey]);

    // Keep the cancel action visible throughout recovery.
    if (!recovering && messageKey !== undefined && messageKey === dismissedKey) return null;
    if (!recovering && !recovered && !message) return null;

    const terminalRecovery = recovery?.phase === "unrecoverable" || recovery?.phase === "cancelled";
    const actions: Array<keyof typeof ACTION_LABELS> = recovering
        ? ["cancelRecovery", "openLogs"]
        : recovered
            ? ["restoreRecovery", "exportRecoveryDiagnostics"]
            : [sessionError ? "openLogs" : terminalRecovery ? "exportRecoveryDiagnostics" : "start"];
    if (!recovering && !recovered && recovery?.canRestore) actions.push("restoreRecovery");
    const bannerMessage = recovering
        ? `${status.message || t("Automatic recovery is in progress")} (${recovery?.usedBoots ?? 0}/${recovery?.maxBoots ?? 8})`
        : recovered
            ? status.message || t("Automatic recovery completed")
            : message;

    return (
        <div className={`dsh-error-banner${recovering || recovered ? " dsh-recovery-banner" : ""}`}
            role={recovering || recovered ? "status" : "alert"}
            aria-live={recovering || recovered ? "polite" : "assertive"}>
            <div className="dsh-error-banner-content">
                <span className="dsh-error-banner-message">{bannerMessage}</span>
                <div className="dsh-error-banner-actions">
                    {actions.map(type => (
                        <button key={type} type="button" className="dsh-button dsh-button-secondary"
                            onClick={() => postAction({ type })}>
                            {t(ACTION_LABELS[type])}
                        </button>
                    ))}
                    {!recovering && (
                        <button type="button" className="dsh-icon-button"
                            aria-label={t("Dismiss")} title={t("Dismiss")}
                            onClick={() => setDismissedKey(messageKey)}>
                            <CloseIcon />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
