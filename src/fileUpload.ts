import { posix } from "node:path";

/**
 * Client for the Harness raw-byte upload route.
 *
 * The web surface uploads a file and sends the returned opaque receipt as a
 * `{ type: "file", receiptId }` content part; the Host resolves that receipt
 * to the stored file and hands the model a readable path when the turn runs.
 * Paths are never derived by a client — the Host owns its own home and layout,
 * so this module stops at the receipt, exactly like the web composer.
 */

/** Raw-byte route owned by the Harness file-upload plugin. */
const UPLOAD_PATH = "/api/session/uploadFileBinary";

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
 * prompt layer, so a malformed response cannot become an empty receipt.
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

/** Basename of a prompt-supplied display name, in the form the route sanitizes to. */
function uploadLeafName(name: string): string {
    const leaf = posix.basename(name.replaceAll("\\", "/"));
    return leaf.slice(0, 255);
}

/** One uploaded file a prompt can cite by its receipt. */
export interface DshPromptFile {
    receiptId: string;
}

/** Content part a prompt carries for one uploaded file. */
export interface DshPromptFilePart {
    receiptId: string;
}

export class DshFileUploads {
    public constructor(private readonly options: DshFileUploadOptions) {}

    /**
     * Upload one file for a Session and report its receipt.
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

        return { receiptId: parsed.receiptId };
    }
}
