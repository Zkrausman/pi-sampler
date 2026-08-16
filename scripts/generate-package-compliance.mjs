import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const noticeFile = "THIRD-PARTY-NOTICES.md";
const sbomFile = "sbom.cdx.json";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function normalizeText(value) {
  return value.replace(/\r\n/g, "\n");
}

export async function publishablePackageDirectories(repositoryRoot = root) {
  const rootManifest = await readJson(join(repositoryRoot, "package.json"));
  const workspacePatterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : rootManifest.workspaces?.packages;
  assert.deepEqual(workspacePatterns, ["extensions/*"], "package workspaces must remain extensions/* for compliance generation");

  const extensionsDirectory = join(repositoryRoot, "extensions");
  const entries = await readdir(extensionsDirectory, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(extensionsDirectory, entry.name);
    const manifest = await readJson(join(directory, "package.json"));
    if (manifest.private !== true) packages.push({ directory, manifest });
  }
  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function componentReference(name) {
  return `pkg:npm/${encodeURIComponent(name)}@`;
}

function deterministicSerialNumber(manifest) {
  const digest = createHash("sha256").update(`${manifest.name}@${manifest.version}`).digest("hex");
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function dependencyComponents(manifest, workspacePackages) {
  const dependencies = [];
  for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, declaredVersion] of Object.entries(manifest[kind] ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const workspaceManifest = workspacePackages.get(name);
      const workspaceVersion = workspaceManifest?.version;
      dependencies.push({
        type: kind === "peerDependencies" ? "library" : "library",
        name,
        version: workspaceVersion ?? declaredVersion,
        purl: workspaceVersion ? `${componentReference(name)}${workspaceVersion}` : undefined,
        license: workspaceManifest?.license ?? "NOASSERTION",
        properties: [
          { name: "pi-sampler:dependency-kind", value: kind },
          { name: "pi-sampler:declared-version", value: declaredVersion },
          ...(workspaceVersion ? [{ name: "pi-sampler:workspace", value: "true" }] : [{ name: "pi-sampler:workspace", value: "false" }]),
        ],
      });
    }
  }
  return dependencies;
}

export function createComplianceArtifacts(manifest, workspacePackages) {
  const dependencies = dependencyComponents(manifest, workspacePackages);
  const component = {
    type: "library",
    name: manifest.name,
    version: manifest.version,
    licenses: [{ license: { id: manifest.license } }],
    purl: `${componentReference(manifest.name)}${manifest.version}`,
  };
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: deterministicSerialNumber(manifest),
    version: 1,
    metadata: {
      component,
      tools: [{ vendor: "pi-sampler", name: "generate-package-compliance", version: "1" }],
    },
    components: dependencies.map((dependency) => ({
      type: dependency.type,
      name: dependency.name,
      version: dependency.version,
      ...(dependency.purl ? { purl: dependency.purl } : {}),
      licenses: [{ license: { id: dependency.license } }],
      properties: dependency.properties,
    })),
    dependencies: [{
      ref: component.purl,
      dependsOn: dependencies.filter((dependency) => dependency.purl).map((dependency) => dependency.purl),
    }],
  };

  const dependencyLines = dependencies.length === 0
    ? ["This artifact declares no runtime or peer dependencies."]
    : dependencies.map((dependency) => {
      const source = workspacePackages.has(dependency.name) ? `workspace version ${dependency.version}` : `declared range ${dependency.version}`;
      return `- \`${dependency.name}\` — ${source}; ${dependency.properties.find((property) => property.name === "pi-sampler:dependency-kind").value}; not bundled in this artifact; license: \`${dependency.license}\`.`;
    });
  const notice = [
    `# Third-party and license notices for ${manifest.name}`,
    "",
    `Artifact version: \`${manifest.version}\``,
    "",
    `This npm artifact is licensed under \`${manifest.license}\`. Its source license text is included as \`LICENSE\`.`,
    "",
    "## Third-party software",
    "",
    "No third-party package is bundled in this npm artifact. npm installs declared dependencies separately. The declared runtime and peer dependencies below are recorded for traceability; where this repository does not carry an authoritative license record, the license is \`NOASSERTION\` rather than an inferred value.",
    "",
    ...dependencyLines,
    "",
    "The accompanying `sbom.cdx.json` is a deterministic CycloneDX 1.5 inventory generated from this package manifest and the workspace package versions. Regenerate after a package version or dependency declaration changes with `npm run generate:compliance`.",
    "",
  ].join("\n");

  return { notice, sbom: `${JSON.stringify(sbom, null, 2)}\n` };
}

export async function validatePackageCompliance({ repositoryRoot = root } = {}) {
  const packages = await publishablePackageDirectories(repositoryRoot);
  const workspacePackages = new Map(packages.map(({ manifest }) => [manifest.name, manifest]));
  const lockfile = await readJson(join(repositoryRoot, "package-lock.json"));
  for (const { directory, manifest } of packages) {
    const workspacePath = directory.slice(repositoryRoot.length + 1).replaceAll("\\", "/");
    assert.equal(lockfile.packages?.[workspacePath]?.version, manifest.version, `${manifest.name}: package-lock workspace version is stale; run npm install --package-lock-only`);
    assert.ok(manifest.files?.includes("LICENSE"), `${manifest.name}: package files must include LICENSE`);
    assert.ok(manifest.files?.includes(noticeFile), `${manifest.name}: package files must include ${noticeFile}`);
    assert.ok(manifest.files?.includes(sbomFile), `${manifest.name}: package files must include ${sbomFile}`);
    const expected = createComplianceArtifacts(manifest, workspacePackages);
    const notice = normalizeText(await readFile(join(directory, noticeFile), "utf8"));
    assert.equal(notice, expected.notice, `${manifest.name}: ${noticeFile} is stale; run npm run generate:compliance`);
    const sbom = normalizeText(await readFile(join(directory, sbomFile), "utf8"));
    assert.equal(sbom, expected.sbom, `${manifest.name}: ${sbomFile} is stale; run npm run generate:compliance`);
  }
  return packages;
}

export async function generatePackageCompliance({ repositoryRoot = root } = {}) {
  const packages = await publishablePackageDirectories(repositoryRoot);
  const workspacePackages = new Map(packages.map(({ manifest }) => [manifest.name, manifest]));
  for (const { directory, manifest } of packages) {
    const { notice, sbom } = createComplianceArtifacts(manifest, workspacePackages);
    await writeFile(join(directory, noticeFile), notice);
    await writeFile(join(directory, sbomFile), sbom);
    console.log(`generated compliance artifacts: ${manifest.name}@${manifest.version}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  (check ? validatePackageCompliance() : generatePackageCompliance())
    .then((packages) => {
      if (check) console.log(`validated compliance artifacts for ${packages.length} publishable package(s).`);
    })
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
