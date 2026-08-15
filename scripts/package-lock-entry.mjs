import {
  BIN_NAME, PACKAGE_LOCK_LIMITS, PLATFORM, SAFE_PATH, boundedString,
  dependencyMap, dependencySpec, exactKeys, integrity, packageName, unsupported, url, version,
} from "./package-lock-validation.mjs";

const PACKAGE_LOCK_ENTRY_KEYS = new Set(["bin", "cpu", "dependencies", "deprecated", "dev", "devDependencies", "devOptional", "engines", "funding", "hasInstallScript", "hasShrinkwrap", "integrity", "libc", "license", "link", "name", "optional", "optionalDependencies", "os", "peer", "peerDependencies", "peerDependenciesMeta", "resolved", "version", "workspaces"]);

function resolved(value, location, packageVersion) {
  value = url(value, "resolved");
  const parts = location.split("/");
  const nodeModules = parts.lastIndexOf("node_modules");
  const name = parts[nodeModules + 1]?.startsWith("@") ? `${parts[nodeModules + 1]}/${parts[nodeModules + 2]}` : parts[nodeModules + 1];
  const unscopedName = name?.split("/").at(-1);
  if (value !== `https://registry.npmjs.org/${name}/-/${unscopedName}-${packageVersion}.tgz`) unsupported("resolved");
}
function packageLocation(location) {
  if (!location) return "root";
  boundedString(location, "package location", 1024);
  const parts = location.split("/");
  if (parts.length > PACKAGE_LOCK_LIMITS.locationDepth || parts.some((part) => !part || part === "." || part === "..")) unsupported("package location");
  if (location.startsWith("extensions/")) {
    if (!SAFE_PATH.test(location)) unsupported("package location");
    return "workspace";
  }
  for (let index = 0; index < parts.length;) {
    if (parts[index++] !== "node_modules") unsupported("package location");
    const name = parts[index++]?.startsWith("@") ? `${parts[index - 1]}/${parts[index++] ?? ""}` : parts[index - 1];
    if (!/^(?:@[a-z0-9][a-z0-9._-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213}|[a-z0-9][a-z0-9._-]{0,213})$/.test(name)) unsupported("package location");
  }
  return "installed";
}
function stringArray(value, label, maximum, pattern = PLATFORM) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) unsupported(label);
  for (const item of value) if (!pattern.test(boundedString(item, label, 64))) unsupported(label);
}
function funding(value) {
  const item = (entry) => {
    if (typeof entry === "string") return url(entry, "funding");
    exactKeys(entry, new Set(["type", "url"]), "funding");
    if (entry.type !== undefined) boundedString(entry.type, "funding type", 64);
    url(entry.url, "funding url");
  };
  if (Array.isArray(value)) {
    if (!value.length || value.length > PACKAGE_LOCK_LIMITS.fundingItems) unsupported("funding");
    for (const entry of value) item(entry);
  } else item(value);
}
export function validatePackageEntry(location, entry, packages) {
  const kind = packageLocation(location);
  exactKeys(entry, PACKAGE_LOCK_ENTRY_KEYS, "package metadata");
  for (const key of ["dev", "devOptional", "hasInstallScript", "hasShrinkwrap", "link", "optional", "peer"]) if (entry[key] !== undefined && typeof entry[key] !== "boolean") unsupported(key);
  if (entry.name !== undefined) packageName(entry.name, "package name");
  if (entry.version !== undefined) version(entry.version, "package version");
  if (entry.resolved !== undefined && !entry.link) resolved(entry.resolved, location, entry.version);
  if (entry.integrity !== undefined) integrity(entry.integrity);
  if (entry.license !== undefined && !/^[A-Za-z0-9.()+ -]{1,256}$/.test(boundedString(entry.license, "license", 256))) unsupported("license");
  if (entry.deprecated !== undefined && !/^[\x20-\x7e]{1,512}$/.test(boundedString(entry.deprecated, "deprecated", 512))) unsupported("deprecated");
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) if (entry[key] !== undefined) dependencyMap(entry[key], key);
  if (entry.engines !== undefined) {
    exactKeys(entry.engines, new Set(["node", "npm", "pnpm", "yarn"]), "engines");
    for (const [engine, range] of Object.entries(entry.engines)) dependencySpec(range, `${engine} engine`);
  }
  if (entry.peerDependenciesMeta !== undefined) {
    exactKeys(entry.peerDependenciesMeta, null, "peerDependenciesMeta");
    for (const [name, metadata] of Object.entries(entry.peerDependenciesMeta)) { packageName(name, "peer dependency name"); exactKeys(metadata, new Set(["optional"]), "peer dependency metadata"); if (typeof metadata.optional !== "boolean") unsupported("peer dependency metadata"); }
  }
  if (entry.bin !== undefined) {
    exactKeys(entry.bin, null, "bin");
    for (const [name, command] of Object.entries(entry.bin)) { if (!BIN_NAME.test(boundedString(name, "bin name", 214))) unsupported("bin name"); if (!SAFE_PATH.test(boundedString(command, "bin command", 256))) unsupported("bin command"); }
  }
  if (entry.funding !== undefined) funding(entry.funding);
  for (const key of ["cpu", "os", "libc"]) if (entry[key] !== undefined) stringArray(entry[key], key, PACKAGE_LOCK_LIMITS.arrayItems);
  if (entry.workspaces !== undefined) stringArray(entry.workspaces, "workspaces", PACKAGE_LOCK_LIMITS.workspaceItems, /^(?:[a-zA-Z0-9._-]+|\*)?(?:\/(?:[a-zA-Z0-9._-]+|\*))*$/);
  if (kind === "root" || kind === "workspace") {
    if (entry.link || entry.resolved !== undefined || entry.integrity !== undefined || entry.name === undefined || entry.version === undefined) unsupported("workspace package metadata");
  } else if (entry.link) {
    if (Object.keys(entry).length !== 2 || typeof entry.resolved !== "string" || !Object.hasOwn(packages, entry.resolved) || packageLocation(entry.resolved) !== "workspace") unsupported("linked package metadata");
  } else if (entry.version === undefined || entry.resolved === undefined) unsupported("installed package metadata");
}
