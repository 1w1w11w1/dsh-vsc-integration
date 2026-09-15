import React, { useCallback, useRef, useState } from "react";
import type { DshFileDraft } from "../../../src/types";
import { t } from "../i18n";
import { CloseIcon } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";

/** One attached file, as the composer holds it before sending. */
export interface DraftFile {
    id: string;
    name: string;
    bytes: number;
    /** Exact bytes, canonically base64 encoded; sent to the Host on demand. */
    data: string;
}

interface PendingDraft extends DraftFile {
    file: File;
}

/**
 * The files a paste or drop should attach.
 *
 * Everything is accepted. A file offer reports an empty `type` for extensions
 * the browser cannot map to a media type — a `.zip`, a `.md`, most editor
 * documents — so filtering on a media type would silently drop exactly the
 * files a user is most likely to attach. Directories are excluded because the
 * Host uploads a single byte stream.
 *
 * @param items - clipboard or drag payload items, in the order offered.
 * @returns the offered files, dropping entries that are not regular files.
 */
export function offeredFiles(
    items: readonly { kind: string; getAsFile(): File | null }[],
): File[] {
    const files: File[] = [];
    for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
    }
    return files;
}

/**
 * Route attached files to the draft store that owns them.
 *
 * Images keep the dedicated path: the Runtime normalizes them, the composer can
 * show a real preview, and the model can see them without a path read. Anything
 * else — including every file whose media type the browser leaves empty — is
 * uploaded as a verbatim file and reaches the model as a path.
 *
 * @param files - files from one paste, drop, or picker selection.
 * @returns the same files split by destination, order preserved in each.
 */
export function splitImageFiles(files: readonly File[]): { images: File[]; others: File[] } {
    const images: File[] = [];
    const others: File[] = [];
    for (const file of files) {
        if (file.type.startsWith("image/")) images.push(file);
        else others.push(file);
    }
    return { images, others };
}

/** Extension of a display name, without the dot; empty when there is none. */
export function fileExtension(name: string): string {
    const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
    const dot = leaf.lastIndexOf(".");
    return dot <= 0 ? "" : leaf.slice(dot + 1);
}

/**
 * Human byte size, in the same units and precision the Harness UI uses.
 *
 * The steps are decimal-reading but binary-based, which is what the rest of the
 * product shows; matching it keeps one file from reading differently in the
 * composer and in the transcript.
 *
 * @param bytes - exact byte length.
 * @returns a short label such as `916B`, `2.3KB`, or `14MB`.
 */
export function fileSizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    const kilobytes = bytes / 1024;
    if (kilobytes < 1024) return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)}KB`;
    const megabytes = kilobytes / 1024;
    if (megabytes < 1024) return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)}MB`;
    const gigabytes = megabytes / 1024;
    return `${gigabytes < 10 ? gigabytes.toFixed(1) : Math.round(gigabytes)}GB`;
}

/** Metadata line under a file name: extension first, then size when known. */
function fileMeta(name: string, bytes: number): string {
    const extension = fileExtension(name).toUpperCase().slice(0, 8);
    return [extension, fileSizeText(bytes)].filter((part) => part !== "").join(" ");
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

/**
 * Composer draft state for general file attachments.
 *
 * Bytes are read once, when the file is attached, so a send never has to touch
 * the original `File` again — the editor may have invalidated it by then.
 */
export function useFileDrafts(limits: { maxBytes: number; maxFiles: number }): {
    files: readonly DraftFile[];
    error?: string;
    accept: string;
    addFiles: (files: readonly File[]) => Promise<void>;
    remove: (id: string) => void;
    clear: () => void;
} {
    const [files, setFiles] = useState<DraftFile[]>([]);
    const [error, setError] = useState<string>();
    // Read at add time so a batch is rejected as a whole rather than in part.
    const pending = useRef<PendingDraft[]>([]);

    const addFiles = useCallback(async (incoming: readonly File[]): Promise<void> => {
        setError(undefined);
        if (incoming.length === 0) return;
        const existing = pending.current;
        if (existing.length + incoming.length > limits.maxFiles) {
            setError(t("A message can contain at most {count} files.", { count: limits.maxFiles }));
            return;
        }
        const totalBytes = existing.reduce((sum, item) => sum + item.bytes, 0) +
            incoming.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > limits.maxBytes) {
            setError(t("Attached files exceed the {size} byte total limit.", {
                size: limits.maxBytes.toLocaleString(),
            }));
            return;
        }

        const additions: PendingDraft[] = [];
        for (const file of incoming) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            additions.push({
                id: crypto.randomUUID(),
                name: file.name || t("file"),
                bytes: bytes.byteLength,
                data: toBase64(bytes),
                file,
            });
        }
        pending.current = [...existing, ...additions];
        setFiles(pending.current.map(({ file: _file, ...draft }) => draft));
    }, [limits.maxBytes, limits.maxFiles]);

    const remove = useCallback((id: string): void => {
        pending.current = pending.current.filter((item) => item.id !== id);
        setFiles(pending.current.map(({ file: _file, ...draft }) => draft));
    }, []);

    const clear = useCallback((): void => {
        pending.current = [];
        setFiles([]);
        setError(undefined);
    }, []);

    return {
        files,
        error,
        // Everything is offered to the picker; the Host enforces the real ceiling.
        accept: "",
        addFiles,
        remove,
        clear,
    };
}

/** Turns the composer's file drafts into the wire payload one prompt carries. */
export function fileDraftsPayload(files: readonly DraftFile[]): DshFileDraft[] {
    return files.map((file) => ({ name: file.name, data: file.data }));
}

/**
 * One pending file, presented the way the Harness web composer presents it: a
 * fixed-size card carrying the type glyph, the name, and extension plus size.
 */
export function FileCard({
    name,
    bytes,
    state = "ready",
    onRemove,
}: {
    name: string;
    bytes: number;
    state?: "ready" | "uploading" | "error";
    onRemove?: () => void;
}): React.JSX.Element {
    const retryable = state === "error";
    const meta = state === "uploading"
        ? t("Uploading...")
        : state === "error"
            ? t("Upload failed")
            : fileMeta(name, bytes);
    return (
        <div className={`dsh-file-card${retryable ? " dsh-file-card-failed" : ""}`} title={name}>
            <span className="dsh-file-card-icon" aria-hidden="true">
                {state === "uploading"
                    ? <span className="dsh-file-card-spinner" />
                    : <FileTypeIcon name={name} size={28} />}
            </span>
            <span className="dsh-file-card-body">
                <span className="dsh-file-card-name">{name}</span>
                <span className="dsh-file-card-meta">{meta}</span>
            </span>
            {onRemove ? (
                <button
                    type="button"
                    className="dsh-file-card-remove"
                    title={t("Remove file")}
                    aria-label={t("Remove file")}
                    onClick={onRemove}
                >
                    <CloseIcon />
                </button>
            ) : null}
            {state === "uploading" ? (
                <span className="dsh-file-card-track"><span className="dsh-file-card-bar" /></span>
            ) : null}
        </div>
    );
}

export function FileDraftRail({
    files,
    error,
    onRemove,
}: {
    files: readonly DraftFile[];
    error?: string;
    onRemove: (id: string) => void;
}): React.JSX.Element | null {
    if (files.length === 0 && !error) return null;
    return (
        <div className="dsh-file-drafts">
            {files.length ? (
                <div className="dsh-file-draft-rail" aria-label={t("Pending files")}>
                    {files.map((file) => (
                        <FileCard
                            key={file.id}
                            name={file.name}
                            bytes={file.bytes}
                            onRemove={() => onRemove(file.id)}
                        />
                    ))}
                </div>
            ) : null}
            {error ? <div className="dsh-card-error">{error}</div> : null}
        </div>
    );
}
