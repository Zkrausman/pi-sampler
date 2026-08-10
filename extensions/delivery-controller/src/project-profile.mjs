const PROFILE_ID = /^[a-z][a-z0-9-]{1,63}$/;

function fail(code) { throw Object.assign(new Error(code), { code }); }

export function normalizeProjectProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("invalid_project_profile");
  if (typeof profile.projectId !== "string" || !PROFILE_ID.test(profile.projectId)) fail("invalid_project_id");
  if (typeof profile.workItem?.idPattern !== "string" || profile.workItem.idPattern.length === 0) fail("invalid_work_item_pattern");
  try { new RegExp(profile.workItem.idPattern); } catch { fail("invalid_work_item_pattern"); }
  if (typeof profile.repository?.source !== "string" || !profile.repository.source.startsWith("sources/")) fail("invalid_repository_source");
  const commands = profile.verification?.commands;
  if (!Array.isArray(commands) || commands.length === 0) fail("invalid_verification_commands");
  const verificationCommands = commands.map((entry, index) => {
    if (!entry || typeof entry.command !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.command) || !Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) fail(`invalid_verification_command_${index}`);
    return { command: entry.command, args: entry.args, label: entry.label ?? [entry.command, ...entry.args].join(" ") };
  });
  if (!Array.isArray(profile.governance?.requiredChecks) || profile.governance.requiredChecks.some((name) => typeof name !== "string" || name.trim() === "")) fail("invalid_required_checks");
  if (typeof profile.governance?.paths?.evidence !== "string" || typeof profile.governance.paths.specification !== "string") fail("invalid_governance_paths");
  return { projectId: profile.projectId, workItemPattern: profile.workItem.idPattern, source: profile.repository.source, verificationCommands, requiredChecks: profile.governance.requiredChecks, paths: profile.governance.paths };
}

export function reviewInputFromProfile(profile, input) {
  const normalized = normalizeProjectProfile(profile);
  if (!new RegExp(normalized.workItemPattern).test(input.ticketId)) fail("work_item_id_does_not_match_profile");
  return { ...input, verificationCommands: normalized.verificationCommands };
}
