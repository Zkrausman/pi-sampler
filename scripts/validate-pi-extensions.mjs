import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { publishablePackages } from "./validate-publishable-packages.mjs";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));

function diagnosticsMessage(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  });
}

function sourceDiagnostics(sourceFile) {
  return sourceFile.parseDiagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function defaultExportType(sourceFile) {
  const program = ts.createProgram({
    rootNames: [sourceFile.fileName],
    options: {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(sourceFile.fileName));
  const defaultSymbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.escapedName === "default");
  assert.ok(defaultSymbol, `${sourceFile.fileName}: Pi extension entry point must have a default export`);
  const defaultType = checker.getTypeOfSymbolAtLocation(defaultSymbol, sourceFile);
  const signatures = checker.getSignaturesOfType(defaultType, ts.SignatureKind.Call);
  assert.ok(signatures.length > 0, `${sourceFile.fileName}: Pi extension default export must be callable`);
  assert.ok(signatures.some((signature) => signature.parameters.length > 0), `${sourceFile.fileName}: Pi extension default export must accept the Pi API`);
}

function smokePiApi() {
  const registrations = [];
  return {
    registrations,
    api: new Proxy({}, {
      get(_target, property) {
        if (property === "then") return undefined;
        return (...args) => { registrations.push({ property: String(property), args }); };
      },
    }),
  };
}

/** Parses, verifies the callable TypeScript export type, and imports an entry point with a no-op Pi API. */
export async function validateEntryPoint(entryPath) {
  assert.equal(extname(entryPath), ".ts", `${entryPath}: Pi extension entry point must be TypeScript`);
  const source = await readFile(entryPath, "utf8");
  const sourceFile = ts.createSourceFile(entryPath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const parseErrors = sourceDiagnostics(sourceFile);
  assert.equal(parseErrors.length, 0, `${entryPath}: TypeScript parse failed:\n${diagnosticsMessage(parseErrors)}`);
  defaultExportType(sourceFile);

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: entryPath,
    reportDiagnostics: true,
  });
  const transpileErrors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(transpileErrors.length, 0, `${entryPath}: TypeScript transpile failed:\n${diagnosticsMessage(transpileErrors)}`);

  const smokePath = join(dirname(entryPath), `.pi-entry-smoke-${randomUUID()}.mjs`);
  await writeFile(smokePath, transpiled.outputText, "utf8");
  try {
    const module = await import(`${pathToFileURL(smokePath).href}?validation=${randomUUID()}`);
    assert.equal(typeof module.default, "function", `${entryPath}: Pi extension default export must load as a function`);
    const { api, registrations } = smokePiApi();
    await module.default(api);
    assert.ok(registrations.length > 0, `${entryPath}: Pi extension smoke test did not register with the Pi API`);
  } finally {
    await unlink(smokePath);
  }
}

export async function publishablePiExtensionEntries(repositoryRoot = root) {
  const packages = await publishablePackages(repositoryRoot);
  const entries = [];
  for (const packageInfo of packages) {
    const extensionEntries = packageInfo.manifest.pi?.extensions;
    if (extensionEntries === undefined) continue;
    assert.ok(Array.isArray(extensionEntries) && extensionEntries.length > 0, `${packageInfo.manifest.name}: pi.extensions must be a non-empty array`);
    for (const entry of extensionEntries) {
      assert.equal(typeof entry, "string", `${packageInfo.manifest.name}: pi.extensions entries must be strings`);
      assert.ok(entry.startsWith("./") && !entry.split("/").includes(".."), `${packageInfo.manifest.name}: unsafe Pi extension entry ${entry}`);
      entries.push({ packageName: packageInfo.manifest.name, entryPath: join(packageInfo.directory, entry) });
    }
  }
  assert.ok(entries.length > 0, "no publishable Pi extension entry points found");
  return entries;
}

export async function validatePiExtensions(repositoryRoot = root) {
  const entries = await publishablePiExtensionEntries(repositoryRoot);
  for (const { packageName, entryPath } of entries) {
    await validateEntryPoint(entryPath);
    console.log(`validated Pi extension entry point: ${packageName} (${entryPath})`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  validatePiExtensions().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
