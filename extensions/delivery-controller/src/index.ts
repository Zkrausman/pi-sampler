import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateControllerConfig } from "./config.mjs";

const envRef = Type.String({ pattern: "^\\$[A-Z][A-Z0-9_]{0,127}$" });
const workItem = Type.Object({
  id: Type.String(), source: Type.String({ pattern: "^sources/" }), branch: Type.String(), baseRef: Type.String(),
  verificationContract: Type.String(), instructions: Type.Array(Type.String(), { minItems: 1 }),
  title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), context: Type.Optional(Type.String()),
});

/** A provider-neutral Pi surface: explicit work only; no selection, merge, or tracker mutation. */
export default function deliveryController(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    pi.registerTool({
      name: "delivery_controller_dispatch", label: "Dispatch explicit work item",
      description: "Dispatches one explicit, profile-configured work item to the configured provider. It never selects work, merges, or changes tracker status.",
      parameters: Type.Object({ config: Type.Object({ ledgerPath: Type.String(), approvalEnvRef: Type.String() }), item: workItem, providerAuthEnvRef: envRef, idempotencyKey: Type.String(), correlationId: Type.String() }),
      async execute(_id, params, _signal, _update, context) {
        const config = validateControllerConfig(params.config as any, { trusted: context.isProjectTrusted(), mode: context.mode } as any);
        if (!config.ok) return { content: [{ type: "text", text: `Controller unavailable: ${(config as any).code}` }], details: config };
        try {
          const { JobLedger } = await import("./ledger.mjs");
          const { JulesAdapter } = await import("./jules-adapter.mjs");
          const { JulesProvider } = await import("./jules-provider.mjs");
          const adapter = new JulesAdapter({ ledger: new JobLedger((params.config as any).ledgerPath), provider: new JulesProvider({ providerAuthEnvRef: (params as any).providerAuthEnvRef }) });
          const result = await adapter.dispatch({ ticket: (params as any).item, idempotencyKey: (params as any).idempotencyKey, correlationId: (params as any).correlationId, approvalEnvRef: (params.config as any).approvalEnvRef, providerAuthEnvRef: (params as any).providerAuthEnvRef });
          return { content: [{ type: "text", text: "Dispatch recorded." }], details: result };
        } catch (error: any) { return { content: [{ type: "text", text: `Dispatch failed: ${error.code ?? "operation_failed"}` }], details: { ok: false, code: error.code ?? "operation_failed" } }; }
      },
    });
  });
}
