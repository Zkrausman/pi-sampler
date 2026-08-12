import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve, win32 } from "node:path";

const MAX_DEFAULT_WRITE_ATTEMPTS = 5;

function pathForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}

function requiredHome(home) {
  if (typeof home !== "string" || !home.trim()) throw new Error("Unable to determine the home directory for hindsight reports.");
  return home.trim();
}

/** Returns the platform-native, per-user directory for default hindsight reports. */
export function defaultHindsightReportDirectory({ platform = process.platform, env = process.env, home } = {}) {
  const path = pathForPlatform(platform);
  const userHome = requiredHome(home);
  if (platform === "win32") {
    const localAppData = typeof env?.LOCALAPPDATA === "string" ? env.LOCALAPPDATA.trim() : "";
    return localAppData ? path.join(localAppData, "pi", "hindsight-reports") : path.join(userHome, ".pi", "hindsight-reports");
  }
  if (platform === "darwin") return path.join(userHome, "Library", "Application Support", "pi", "hindsight-reports");
  const xdgDataHome = typeof env?.XDG_DATA_HOME === "string" ? env.XDG_DATA_HOME.trim() : "";
  return xdgDataHome ? path.join(xdgDataHome, "pi", "hindsight-reports") : path.join(userHome, ".local", "share", "pi", "hindsight-reports");
}

/** Keeps only the known-safe pseudonymous label emitted by pseudonymizeSession. */
export function safeSessionReference(reference) {
  const match = /^session-([a-z0-9]+)$/i.exec(typeof reference === "string" ? reference.trim() : "");
  return match ? `session-${match[1].toLowerCase()}` : "session";
}

/** Creates a Windows-safe, non-identifying default report filename. */
export function defaultHindsightReportFilename(reference, { now = () => new Date(), uuid = randomUUID } = {}) {
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  return `pi-hindsight-${safeSessionReference(reference)}-${timestamp}-${uuid()}.html`;
}

export function resolveExplicitHindsightOutputPath(requestedPath, cwd) {
  if (requestedPath.includes("\0")) throw new Error("The output path is invalid.");
  const outputPath = resolve(cwd, requestedPath);
  if (extname(outputPath).toLowerCase() !== ".html") throw new Error("The hindsight document output path must end in .html.");
  return outputPath;
}

export function defaultHindsightOutputPath(reference, options) {
  const directory = defaultHindsightReportDirectory(options);
  return pathForPlatform(options?.platform ?? process.platform).join(directory, defaultHindsightReportFilename(reference, options));
}

export function isOutputAlreadyExists(error) {
  return Boolean(error && typeof error === "object" && (error.code === "EEXIST" || isOutputAlreadyExists(error.cause)));
}

/** Atomically publishes a completed report without replacing an existing file. */
export async function writeHindsightReport(outputPath, html, { uuid = randomUUID } = {}) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${uuid()}.tmp`);
  try {
    await writeFile(temporaryPath, html, { encoding: "utf8", flag: "wx" });
    await link(temporaryPath, outputPath);
  } catch (error) {
    if (isOutputAlreadyExists(error)) throw new Error(`The hindsight document output already exists: ${outputPath}`, { cause: error });
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Writes a generated default name, regenerating only if an improbable collision occurs. */
export async function writeDefaultHindsightReport({ directory, reference, html, now, uuid = randomUUID }) {
  for (let attempt = 0; attempt < MAX_DEFAULT_WRITE_ATTEMPTS; attempt += 1) {
    const outputPath = join(directory, defaultHindsightReportFilename(reference, { now, uuid }));
    try {
      await writeHindsightReport(outputPath, html, { uuid });
      return outputPath;
    } catch (error) {
      if (!isOutputAlreadyExists(error) || attempt === MAX_DEFAULT_WRITE_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error("Unable to allocate a unique hindsight document output path.");
}
