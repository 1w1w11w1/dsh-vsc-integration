import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Whether `candidate` is `root` itself or lies beneath it.
 *
 * Both arguments must already be resolved; callers that also need symlinks
 * collapsed are responsible for passing real paths, since this check is purely
 * lexical.
 *
 * The escape test deliberately matches `..` only as a whole segment — a bare
 * `..` or a `../` prefix. Testing `startsWith("..")` instead would also reject
 * entries whose name merely begins with two dots (`..config`), which are legal
 * on every platform and are inside the root.
 */
export function containsPath(root: string, candidate: string): boolean {
    const child = relative(root, candidate);
    return child === "" ||
        (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/**
 * Whether two resolved paths denote the same location, by mutual containment.
 *
 * Like {@link containsPath} this is purely lexical, so callers comparing paths
 * that may involve symlinks must pass real paths.
 */
export function samePath(left: string, right: string): boolean {
    return containsPath(left, right) && containsPath(right, left);
}

/**
 * Place a sha256-named object file under its two-character fan-out directory.
 *
 * Content-addressed stores scatter objects by digest prefix so one directory
 * never accumulates every entry. The DSH attachment store and this extension's
 * own caches share that layout, so the fan-out is derived here once rather than
 * restated per store.
 *
 * @param root - Absolute directory holding the object subtrees.
 * @param sha256 - Lowercase hex digest of the stored bytes.
 * @returns the absolute object path, without reading or creating anything.
 */
export function sha256ScopedFile(root: string, sha256: string): string {
    return join(root, sha256.slice(0, 2), sha256);
}
