import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

// POSIX exec preserves process ownership; Windows needs a native launcher.
export async function createRecoveryLauncher(directory, source) {
    const root = join(directory, "shim");
    await mkdir(root, { recursive: true });
    const fixture = join(root, "fake-dsh.cjs");
    await writeFile(fixture, await readFile(source), { mode: 0o600 });
    const launcher = join(root, process.platform === "win32" ? "dsh.exe" : "dsh");
    if (process.platform === "win32") {
        process.env.DSH_SHIM_NODE = process.execPath;
        const compiler = join(process.env.WINDIR || "C:\\Windows",
            "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
        const sourcePath = new URL("./verify-adopt-shim.cs", import.meta.url);
        const shimSource = join(root, "shim.cs");
        await writeFile(shimSource, await readFile(sourcePath));
        await promisify(execFile)(compiler, ["/nologo", `/out:${launcher}`, shimSource]);
    } else {
        const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
        await writeFile(launcher,
            `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
    }
    return launcher;
}
