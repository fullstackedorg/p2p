// Last-write-wins on Lamport versions. See docs/3-subsystems/state-store.md §1.
import type { Entry, Version } from "./types.ts";

/** > 0 when a is newer than b, < 0 when older, 0 for the same write. */
export function compareVersion(a: Version, b: Version): number {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] === b[1]) return 0;
    return a[1] > b[1] ? 1 : -1;
}

/** Stores entry when it is newer than the current one; returns whether it did. */
export function applyEntry(map: Map<string, Entry>, key: string, entry: Entry): boolean {
    const current = map.get(key);
    if (current && compareVersion(entry.version, current.version) <= 0) return false;
    map.set(key, entry);
    return true;
}

export function isVersion(value: unknown): value is Version {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        Number.isSafeInteger(value[0]) &&
        value[0] > 0 &&
        typeof value[1] === "string" &&
        value[1].length > 0
    );
}

export function tombstone(
    version: Version,
    updatedBy: string,
    deviceId: string,
    updatedAt: number
): Entry {
    return { value: null, deleted: true, version, updatedBy, deviceId, updatedAt };
}

/** The JSON type name reported by `schema` for a state value. */
export function valueType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}
