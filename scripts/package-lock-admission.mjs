import { validatePackageEntry } from "./package-lock-entry.mjs";
import { PACKAGE_LOCK_LIMITS, packageName, plainObject, version } from "./package-lock-validation.mjs";

const PACKAGE_LOCK_TOP_LEVEL_KEYS = Object.freeze(["lockfileVersion", "name", "packages", "requires", "version"]);

/** Validate the only oversized endpoint exception without producing packet material. */
export function validateOversizedPackageLockfile(content) {
  let lockfile;
  try { lockfile = JSON.parse(content); } catch { throw new Error("package-lock.json is not supported canonical npm lockfile JSON"); }
  if (!plainObject(lockfile) || Object.keys(lockfile).sort().join(",") !== PACKAGE_LOCK_TOP_LEVEL_KEYS.join(",")
    || lockfile.lockfileVersion !== 3 || lockfile.requires !== true || !plainObject(lockfile.packages)
    || Object.keys(lockfile.packages).length < 1 || Object.keys(lockfile.packages).length > PACKAGE_LOCK_LIMITS.packageCount || !plainObject(lockfile.packages[""])) {
    throw new Error("package-lock.json is not a supported npm lockfileVersion 3 generated lockfile");
  }
  if (`${JSON.stringify(lockfile, null, 2)}\n` !== content) throw new Error("package-lock.json is not canonical npm-generated lockfile content");
  if (packageName(lockfile.name, "top-level name") !== packageName(lockfile.packages[""].name, "root name") || version(lockfile.version, "top-level version") !== version(lockfile.packages[""].version, "root version")) {
    throw new Error("package-lock.json has unsupported root metadata");
  }
  for (const [location, entry] of Object.entries(lockfile.packages)) validatePackageEntry(location, entry, lockfile.packages);
}
