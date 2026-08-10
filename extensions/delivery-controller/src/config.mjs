const ENV_REFERENCE = /^\$[A-Z][A-Z0-9_]{0,127}$/;

export function validateControllerConfig(value, { trusted, mode, env = process.env } = {}) {
  if (!trusted) return { ok: false, code: "project_not_trusted" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "invalid_config" };
  const keys = Object.keys(value);
  if (keys.some((key) => !["ledgerPath", "approvalEnvRef"].includes(key))) return { ok: false, code: "invalid_config" };
  if (typeof value.ledgerPath !== "string" || value.ledgerPath.trim() === "" || value.ledgerPath.includes("..") || value.ledgerPath.startsWith("/") || /^[A-Za-z]:/.test(value.ledgerPath)) return { ok: false, code: "invalid_ledger_path" };
  if (typeof value.approvalEnvRef !== "string" || !ENV_REFERENCE.test(value.approvalEnvRef)) return { ok: false, code: "invalid_approval_reference" };
  if (mode !== "tui" && env[value.approvalEnvRef.slice(1)] !== "approved") return { ok: false, code: "noninteractive_approval_required" };
  return { ok: true, config: { ledgerPath: value.ledgerPath, approvalEnvRef: value.approvalEnvRef } };
}
