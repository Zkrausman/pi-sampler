import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateControllerConfig } from "./config.mjs";
import { DeliveryTicketLifecycleAdapter } from "./ticket-lifecycle-adapter.mjs";

const envRef = Type.String({ pattern: "^\\$[A-Z][A-Z0-9_]{0,127}$" });
const workItem = Type.Object({
  id: Type.String(), source: Type.String({ pattern: "^sources/" }), branch: Type.String(), baseRef: Type.String(),
  verificationContract: Type.String(), instructions: Type.Array(Type.String(), { minItems: 1 }),
  title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), context: Type.Optional(Type.String()),
});

/** A provider-neutral Pi surface: explicit work only; no selection, merge, or tracker mutation. */
export default function deliveryController(pi: ExtensionAPI) {
  let lifecycle: DeliveryTicketLifecycleAdapter | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const sessionId = ctx.sessionManager.getSessionFile?.() ?? "session-local";
    lifecycle = new DeliveryTicketLifecycleAdapter({ pi, cwd: ctx.cwd, sessionId: typeof sessionId === "string" ? sessionId.replaceAll(/[^A-Za-z0-9._:-]/g, "-").slice(-128) || "session-local" : "session-local" });
    const command = async (operation: "pickup" | "start" | "settle" | "awaiting" | "merged" | "closed", args: string, commandCtx: any) => {
      if (!commandCtx.isProjectTrusted()) { commandCtx.ui?.notify?.("Ticket lifecycle requires a trusted project.", "error"); return; }
      try {
        const value = args.trim(); let result;
        if (operation === "pickup") result = await lifecycle?.pickup(value);
        else if (operation === "start") result = await lifecycle?.start(value);
        else if (operation === "settle") result = await lifecycle?.settle(value);
        else if (operation === "awaiting") result = await lifecycle?.awaitingMerge(value);
        else result = await lifecycle?.attest(value, operation);
        commandCtx.ui?.notify?.(`Ticket lifecycle ${operation}: ${result?.handle ?? "complete"}.`, "info");
      } catch (error: any) { commandCtx.ui?.notify?.(`Ticket lifecycle ${operation} failed: ${error?.code ?? "operation_failed"}.`, "error"); }
    };
    pi.registerCommand("ticket-lifecycle-pickup", { description: "Host/operator: pick up a pre-manifested local work item", handler: (args, commandCtx) => command("pickup", args, commandCtx) });
    pi.registerCommand("ticket-lifecycle-start", { description: "Host/operator: start a cost segment for an opaque lifecycle handle", handler: (args, commandCtx) => command("start", args, commandCtx) });
    pi.registerCommand("ticket-lifecycle-settle", { description: "Host/operator: settle the active cost segment for an opaque lifecycle handle", handler: (args, commandCtx) => command("settle", args, commandCtx) });
    pi.registerCommand("ticket-lifecycle-awaiting-merge", { description: "Host/operator: mark a settled lifecycle handle awaiting merge", handler: (args, commandCtx) => command("awaiting", args, commandCtx) });
    pi.registerCommand("ticket-lifecycle-merged", { description: "Host/operator: consume local merge attestation for a lifecycle handle", handler: (args, commandCtx) => command("merged", args, commandCtx) });
    pi.registerCommand("ticket-lifecycle-closed", { description: "Host/operator: consume local close attestation and finalize a lifecycle handle", handler: (args, commandCtx) => command("closed", args, commandCtx) });
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
  pi.on("session_shutdown", async () => { await lifecycle?.interruptPending().catch(() => {}); lifecycle = undefined; });
}
