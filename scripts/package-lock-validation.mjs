const PACKAGE_LOCK_LIMITS = Object.freeze({ packageCount: 10_000, locationDepth: 32, string: 512, dependencySpec: 256, url: 512, integrity: 256, objectKeys: 512, arrayItems: 64, fundingItems: 16, workspaceItems: 64 });
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213}|[a-z0-9][a-z0-9._-]{0,213})$/;
const BIN_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,213}$/;
const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_SPEC_OPERATOR = new Set(["~", "^", "<", ">", "="]);
const SAFE_PATH = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PLATFORM = /^!?[a-z0-9][a-z0-9-]{0,31}$/;

export function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function unsupported(label) { throw new Error(`package-lock.json has unsupported ${label}`); }
function boundedString(value, label, maximum = PACKAGE_LOCK_LIMITS.string) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximum || /[\0\r\n]/.test(value)) unsupported(label);
  return value;
}
export function exactKeys(value, keys, label) {
  if (!plainObject(value) || (keys && Object.keys(value).some((key) => !keys.has(key))) || Object.keys(value).length > PACKAGE_LOCK_LIMITS.objectKeys) unsupported(label);
}
export function packageName(value, label) {
  value = boundedString(value, label, 214);
  if (!PACKAGE_NAME.test(value)) unsupported(label);
  return value;
}
export function version(value, label) {
  value = boundedString(value, label, 128);
  if (!SEMVER.test(value)) unsupported(label);
  return value;
}
export function dependencySpec(value, label) {
  value = boundedString(value, label, PACKAGE_LOCK_LIMITS.dependencySpec);
  // Parse the intentionally narrow npm range subset one character at a time.
  // This avoids the ambiguous nested repetition that a regular expression used
  // here previously, while retaining the range forms emitted by npm lockfiles.
  let index = 0;
  const isWhitespace = (character) => character === " " || character === "\t" || character === "\f" || character === "\v";
  const isDigit = (character) => character >= "0" && character <= "9";
  const isSuffixCharacter = (character) => (character >= "0" && character <= "9") || (character >= "A" && character <= "Z") || (character >= "a" && character <= "z") || character === "." || character === "-";
  const whitespace = () => { while (isWhitespace(value[index])) index += 1; };
  const comparators = () => { while (DEPENDENCY_SPEC_OPERATOR.has(value[index])) index += 1; };
  const atom = () => {
    const hasVersionPrefix = value[index] === "v";
    if (hasVersionPrefix) index += 1;
    if (!hasVersionPrefix && (value[index] === "x" || value[index] === "X" || value[index] === "*")) { index += 1; return true; }
    if (!isDigit(value[index])) return false;
    while (isDigit(value[index])) index += 1;
    for (let components = 0; components < 2 && value[index] === "."; components += 1) {
      index += 1;
      if (!isDigit(value[index])) return false;
      while (isDigit(value[index])) index += 1;
    }
    return true;
  };
  const rangeVersion = () => {
    if (!atom()) return false;
    const separator = value[index];
    if (separator === "+" || (separator === "-" && isSuffixCharacter(value[index + 1]))) {
      index += 1;
      const suffixStart = index;
      while (isSuffixCharacter(value[index])) index += 1;
      if (index === suffixStart) return false;
    }
    return true;
  };
  comparators(); whitespace();
  if (!rangeVersion()) unsupported(label);
  while (index < value.length) {
    whitespace();
    if (index === value.length) unsupported(label);
    if (value.startsWith("||", index)) index += 2;
    else if (value[index] === "-") index += 1;
    whitespace(); comparators(); whitespace();
    if (!rangeVersion()) unsupported(label);
  }
  return value;
}
export function dependencyMap(value, label) {
  exactKeys(value, null, label);
  for (const [name, spec] of Object.entries(value)) { packageName(name, `${label} name`); dependencySpec(spec, `${label} spec`); }
}
export function url(value, label) {
  value = boundedString(value, label, PACKAGE_LOCK_LIMITS.url);
  let parsed;
  try { parsed = new URL(value); } catch { unsupported(label); }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) unsupported(label);
  return value;
}
export function integrity(value) {
  value = boundedString(value, "integrity", PACKAGE_LOCK_LIMITS.integrity);
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 || Buffer.from(match[2], "base64").toString("base64") !== match[2]
    || Buffer.from(match[2], "base64").length !== ({ sha1: 20, sha256: 32, sha384: 48, sha512: 64 })[match[1]]) unsupported("integrity");
}
export { BIN_NAME, PACKAGE_LOCK_LIMITS, PLATFORM, SAFE_PATH, boundedString, unsupported };
