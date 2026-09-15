#!/usr/bin/env node
// Loopback Harness upload route -> DSH file-upload client contract smoke.
// Usage: npx tsc -p tsconfig.json && node scripts/verify-file-upload.mjs
// No network, model calls, or real Runtime are needed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { DshFileUploads, attachmentStoredPath, fileContentId } =
    require("../dist/fileUpload");

const failures = [];
async function scenario(label, run) {
    try { await run(); console.log(`PASS ${label}`); }
    catch (error) { failures.push(error); console.error(`FAIL ${label}: ${error.message}`); }
}

/** Start a loopback server that records the one request it answers. */
async function harness(reply) {
    const seen = [];
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        seen.push({
            method: request.method,
            url: request.url,
            contentType: request.headers["content-type"],
            cookie: request.headers.cookie,
            body,
        });
        const answer = await reply(body);
        response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
        seen,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

const HOME = process.platform === "win32" ? "C:\\dsh-home" : "/dsh-home";
const SESSION = "session-1";

/** Upload one payload against a stub that echoes a well-formed receipt. */
async function uploadWith(data, options = {}) {
    const digest = createHash("sha256").update(data).digest("hex");
    const stub = await harness(async () => ({
        body: {
            ok: true,
            value: {
                receiptId: "receipt-1",
                file: {
                    attachmentId: `sha256:${digest}`,
                    name: options.storedName ?? "notes.pdf",
                    bytes: options.storedBytes ?? data.byteLength,
                },
            },
        },
    }));
    const uploads = new DshFileUploads({
        baseUrl: stub.baseUrl,
        requestHeaders: () => ({ cookie: "dsh_session=abc" }),
        dshHome: () => HOME,
        maxBytes: () => options.maxBytes ?? 10 * 1024 * 1024,
    });
    try {
        const file = await uploads.upload(SESSION, options.name ?? "notes.pdf", data);
        return { file, stub };
    } catch (error) {
        return { error, stub };
    }
}

await scenario("the route receives the exact bytes under the documented header", async () => {
    const data = Buffer.from("hello dsh", "utf8");
    const { file, stub } = await uploadWith(data);
    try {
        assert.equal(stub.seen.length, 1);
        const request = stub.seen[0];
        assert.equal(request.method, "POST");
        // The route rejects any other media type with HTTP 415.
        assert.equal(request.contentType, "application/octet-stream");
        assert.ok(request.url.startsWith("/api/session/uploadFileBinary?"));
        const query = new URL(request.url, "http://127.0.0.1").searchParams;
        assert.equal(query.get("sessionId"), SESSION);
        assert.equal(query.get("name"), "notes.pdf");
        // Authentication rides the same cookie the RC client uses.
        assert.equal(request.cookie, "dsh_session=abc");
        assert.deepEqual(request.body, data);
        assert.equal(file.bytes, data.byteLength);
    } finally { await stub.close(); }
});

await scenario("a directory-bearing name is reduced to its leaf before upload", async () => {
    const { stub } = await uploadWith(Buffer.from("x"), { name: "C:\\tmp\\a\\b.txt" });
    try {
        const query = new URL(stub.seen[0].url, "http://127.0.0.1").searchParams;
        assert.equal(query.get("name"), "b.txt");
    } finally { await stub.close(); }
});

await scenario("the stored path follows the content-addressed attachment layout", async () => {
    const data = Buffer.from("stored", "utf8");
    const digest = createHash("sha256").update(data).digest("hex");
    const { file, stub } = await uploadWith(data);
    try {
        assert.equal(file.storedPath, join(HOME, "attachments", "v1", "files",
            digest.slice(0, 2), digest, "notes.pdf"));
    } finally { await stub.close(); }
});

await scenario("identical bytes resolve to one stored object", async () => {
    const data = Buffer.from("same", "utf8");
    const first = await uploadWith(data, { name: "a.txt", storedName: "a.txt" });
    const second = await uploadWith(data, { name: "b.txt", storedName: "b.txt" });
    try {
        // Only the leaf name differs, so the directory digest is shared.
        assert.equal(
            join(first.file.storedPath, ".."),
            join(second.file.storedPath, ".."),
        );
    } finally { await first.stub.close(); await second.stub.close(); }
});

await scenario("a file over the ceiling is refused without a request", async () => {
    const { error, stub } = await uploadWith(Buffer.alloc(2048), { maxBytes: 1024 });
    try {
        assert.ok(error, "an oversized file must be refused");
        assert.equal(stub.seen.length, 0, "the ceiling must be enforced before the request");
    } finally { await stub.close(); }
});

await scenario("a business failure in a 200 envelope is not treated as success", async () => {
    const stub = await harness(async () => ({
        body: { ok: false, error: { code: "session/attachment-invalid", message: "File was not uploaded for this session." } },
    }));
    const uploads = new DshFileUploads({
        baseUrl: stub.baseUrl,
        requestHeaders: () => ({}),
        dshHome: () => HOME,
        maxBytes: () => 1024,
    });
    try {
        await assert.rejects(
            () => uploads.upload(SESSION, "a.txt", Buffer.from("x")),
            /File was not uploaded for this session/u,
        );
    } finally { await stub.close(); }
});

await scenario("a byte-count mismatch is refused rather than reported as stored", async () => {
    const { error, stub } = await uploadWith(Buffer.from("12345"), { storedBytes: 3 });
    try {
        assert.ok(error, "a truncated store must not look like a successful upload");
    } finally { await stub.close(); }
});

await scenario("an upload with no reachable Runtime reports its own failure", async () => {
    const uploads = new DshFileUploads({
        baseUrl: () => undefined,
        requestHeaders: () => ({}),
        dshHome: () => HOME,
        maxBytes: () => 1024,
    });
    await assert.rejects(
        () => uploads.upload(SESSION, "a.txt", Buffer.from("x")),
        /not running/u,
    );
});

await scenario("a reference this layout cannot describe yields no path", async () => {
    assert.equal(attachmentStoredPath(HOME, { attachmentId: "opaque", name: "a.txt", bytes: 1 }), undefined);
    assert.equal(attachmentStoredPath("relative", { attachmentId: fileContentId(Buffer.from("x")), name: "a.txt", bytes: 1 }), undefined);
});

if (failures.length > 0) {
    console.error(`${failures.length} scenario(s) failed`);
    process.exit(1);
}
console.log("file-upload smoke: all scenarios passed");
