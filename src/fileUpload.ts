import { createHash } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";
import { sha256ScopedFile } from "./paths";

/**
 * Client for the Harness raw-byte upload route.
 *
 * DSH stores an uploaded file verbatim under its attachment root and answers
 * with an opaque receipt. That receipt is what a prompt cites; the stored path
 * is deliberately never on the wire. This module owns both halves of that
 * contract for the extension: the upload call, and the local derivation of the
 * stored path a prompt has to name instead.
 */

/** Raw-byte route owned by the Harness file-upload plugin. */
const UPLOAD_PATH = "/api/session/uploadFileBinary";

/**
 * Attachment root the Harness stores verbatim files under, relative to its
 * home. Mirrors the DSH attachment provider's layout:
 * `<root>/files/<digest prefix>/<digest>/<name>`.
 */
const ATTACHMENT_FILES_SEGMENTS = ["attachments", "v1", "files"] as const;

/** Durable reference to one verbatim stored file, as the upload route reports it. */
export interface DshUploadedFileRef {
    /** Opaque content-addressed storage identifier; never a filesystem path. */
    attachmentId: string;
    /** Sanitized display filename, also the stored object's leaf name. */
    name: string;
    /** Exact byte length. */
    bytes: number;
}

/** Result of one staged upload. */
export interface DshUploadedFile {
    /** Authority accepted only inside the receiving Session scope. */
    receiptId: string;
    file: DshUploadedFileRef;
}

export interface DshFileUploadOptions {
    /** Runtime base URL, or `undefined` while it is not running. */
    baseUrl: string | (() => string | undefined);
    /** Authenticated request headers, evaluated per call. */
    requestHeaders: () => Record<string, string>;
    /** Harness home the attachment root hangs off, or `undefined` when unknown. */
    dshHome: () => string | undefined;
    /** Byte ceiling enforced before a request is attempted. */
    maxBytes: () => number;
    /** Injected for tests; defaults to the global fetch. */
    fetch?: typeof fetch;
}

export class DshFileUploadError extends Error {
    public constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "DshFileUploadError";
    }
}

/**
 * Reject a value that is not a well-formed upload result before it reaches the
 * prompt layer, so a malformed response cannot become an empty path.
 */
function parseUploadResult(value: unknown): DshUploadedFile | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const receiptId = record.receiptId;
    const file = record.file;
    if (typeof receiptId !== "string" || receiptId.length === 0) return undefined;
    if (typeof file !== "object" || file === null || Array.isArray(file)) return undefined;
    const ref = file as Record<string, unknown>;
    if (typeof ref.attachmentId !== "string" || typeof ref.name !== "string") return undefined;
    if (typeof ref.bytes !== "number" || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) return undefined;
    if (ref.name.length === 0 || ref.name.includes("/") || ref.name.includes("\\")) return undefined;
    return {
        receiptId,
        file: { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes },
    };
}

/**
 * Digest carried by an attachment id of the form `sha256:<hex>`.
 * @returns the lowercase hex digest, or `undefined` for any other shape.
 */
export function attachmentDigest(attachmentId: string): string | undefined {
    const match = /^sha256:([0-9a-f]{64})$/u.exec(attachmentId);
    return match?.[1];
}

/**
 * Absolute path the Harness stores one uploaded file at.
 *
 * The stored path is content-addressed, so uploading identical bytes twice
 * resolves to the same file. Names that differ only by directory resolve to the
 * same object too, because the upload route reduces a supplied name to its leaf.
 *
 * @param home - Harness home directory. Callers that cannot prove it belongs to
 * the connected Runtime must not treat the result as authoritative.
 * @param file - Durable reference reported by the upload route.
 * @returns the absolute stored path, or `undefined` when the reference is not
 * one this layout can describe.
 */
export function attachmentStoredPath(
    home: string,
    file: DshUploadedFileRef,
): string | undefined {
    const digest = attachmentDigest(file.attachmentId);
    if (digest === undefined || !isAbsolute(home)) return undefined;
    // The depth varies by platform, so the root is joined natively and only the
    // fixed attachment segments are appended lexically.
    return join(
        sha256ScopedFile(join(home, ...ATTACHMENT_FILES_SEGMENTS), digest),
        file.name,
    );
}

/** Basename of a prompt-supplied display name, in the form the route sanitizes to. */
function uploadLeafName(name: string): string {
    const leaf = posix.basename(name.replaceAll("\\", "/"));
    return leaf.slice(0, 255);
}

/** One uploaded file the prompt layer can both cite and describe. */
export interface DshPromptFile {
    receiptId: string;
    name: string;
    bytes: number;
    /** Stored path, present only when it could be derived with certainty. */
    storedPath?: string;
}

export class DshFileUploads {
    public constructor(private readonly options: DshFileUploadOptions) {}

    /**
     * Upload one file for a Session and report where the Harness stored it.
     *
     * @param sessionId - Session that owns the staged receipt.
     * @param name - Display name, reduced to its leaf before it is sent.
     * @param data - Exact file bytes.
     * @param signal - Optional cancellation for the active upload.
     * @throws DshFileUploadError when the Runtime is absent, the ceiling is
     * exceeded, or the route refuses the upload.
     */
    public async upload(
        sessionId: string,
        name: string,
        data: Uint8Array,
        signal?: AbortSignal,
    ): Promise<DshPromptFile> {
        const limit = this.options.maxBytes();
        if (data.byteLength > limit) {
            throw new DshFileUploadError(
                `The file is ${data.byteLength.toLocaleString()} bytes, over the ${limit.toLocaleString()} byte upload limit.`,
            );
        }
        const base = typeof this.options.baseUrl === "function"
            ? this.options.baseUrl()
            : this.options.baseUrl;
        if (!base) {
            throw new DshFileUploadError("The dsh Runtime is not running, so the file cannot be uploaded.");
        }
        const leaf = uploadLeafName(name);
        if (leaf.length === 0) {
            throw new DshFileUploadError("A file to upload needs a name.");
        }

        const url = new URL(UPLOAD_PATH, base.endsWith("/") ? base : `${base}/`);
        url.searchParams.set("sessionId", sessionId);
        url.searchParams.set("name", leaf);

        let response: Response;
        try {
            response = await (this.options.fetch ?? fetch)(url.toString(), {
                method: "POST",
                headers: {
                    ...this.options.requestHeaders(),
                    "content-type": "application/octet-stream",
                },
                body: data as BodyInit,
                signal,
            });
        } catch (cause) {
            throw new DshFileUploadError("The file upload could not reach the dsh Runtime.", { cause });
        }
        if (!response.ok) {
            throw new DshFileUploadError(
                `The dsh Runtime refused the upload (HTTP ${response.status}).`,
            );
        }
        // The route answers 200 with an envelope on business failures too, so the
        // status alone cannot decide success.
        let envelope: unknown;
        try {
            envelope = await response.json();
        } catch (cause) {
            throw new DshFileUploadError("The upload response was not JSON.", { cause });
        }
        if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
            throw new DshFileUploadError("The upload response was malformed.");
        }
        const result = envelope as Record<string, unknown>;
        if (result.ok === false) {
            const error = result.error;
            const message = typeof error === "object" && error !== null && !Array.isArray(error)
                ? (error as Record<string, unknown>).message
                : undefined;
            throw new DshFileUploadError(
                typeof message === "string" && message.length > 0
                    ? message
                    : "The dsh Runtime refused the upload.",
            );
        }
        const parsed = parseUploadResult(result.value);
        if (!parsed) {
            throw new DshFileUploadError("The dsh Runtime returned an unusable upload receipt.");
        }
        if (parsed.file.bytes !== data.byteLength) {
            throw new DshFileUploadError(
                `The dsh Runtime stored ${parsed.file.bytes.toLocaleString()} bytes for a ${data.byteLength.toLocaleString()} byte file.`,
            );
        }

        const home = this.options.dshHome();
        const storedPath = home === undefined
            ? undefined
            : attachmentStoredPath(home, parsed.file);
        return {
            receiptId: parsed.receiptId,
            name: parsed.file.name,
            bytes: parsed.file.bytes,
            ...(storedPath === undefined ? {} : { storedPath }),
        };
    }
}

/** Digest of one file, as the DSH attachment id spells it. */
export function fileContentId(data: Uint8Array): string {
    return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
