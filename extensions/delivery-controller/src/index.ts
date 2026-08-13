import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateControllerConfig } from "./config.mjs";
import { DeliveryTicketLifecycleAdapter } from "./ticket-lifecycle-adapter.mjs";

const envRef = Type.String({ pattern: "^\\$[A-Z][A-Z0-9_]{0,127}$" });
const dispatchInput = Type.Object({ config: Type.Object({ ledgerPath: Type.String(), approvalEnvRef: Type.String() }), lifecycleHandle: Type.String({ pattern: "^hdl-[a-f0-9]{24}$" }), providerAuthEnvRef: envRef, idempotencyKey: Type.String(), correlationId: Type.String() });

/** Provider-neutral dispatch plus host-only durable ticket-lifecycle reference adapter. */
export default function deliveryController(pi: ExtensionAPI) {
  let lifecycle: DeliveryTicketLifecycleAdapter | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const session = ctx.sessionManager.getSessionFile?.() ?? "session-local";
    lifecycle = new DeliveryTicketLifecycleAdapter({ pi, cwd: ctx.cwd, sessionId: session });
    try { await lifecycle.reconcile(); } catch (error: any) { ctx.ui?.notify?.(`Ticket lifecycle recovery failed: ${error?.code ?? "operation_failed"}.`, "error"); return; }
    const command = async (op: "pickup" | "start" | "settle" | "awaiting" | "merged" | "closed", args: string, commandCtx: any) => {
      if (!commandCtx.isProjectTrusted()) { commandCtx.ui?.notify?.("Ticket lifecycle requires a trusted project.", "error"); return; }
      try { const value = args.trim(); const result = op === "pickup" ? await lifecycle?.pickup(value) : op === "start" ? await lifecycle?.start(value) : op === "settle" ? await lifecycle?.settle(value) : op === "awaiting" ? await lifecycle?.awaitingMerge(value) : await lifecycle?.attest(value, op); commandCtx.ui?.notify?.(`Ticket lifecycle ${op}: ${result?.handle ?? "complete"}.`, "info"); }
      catch (error: any) { commandCtx.ui?.notify?.(`Ticket lifecycle ${op} failed: ${error?.code ?? "operation_failed"}.`, "error"); }
    };
    pi.registerCommand("ticket-lifecycle-pickup", { description: "Host/operator: pick up pre-manifested local work", handler: (a, c) => command("pickup", a, c) });
    pi.registerCommand("ticket-lifecycle-start", { description: "Host/operator: start opaque lifecycle handle", handler: (a, c) => command("start", a, c) });
    pi.registerCommand("ticket-lifecycle-settle", { description: "Host/operator: settle opaque lifecycle handle", handler: (a, c) => command("settle", a, c) });
    pi.registerCommand("ticket-lifecycle-awaiting-merge", { description: "Host/operator: await merge for settled handle", handler: (a, c) => command("awaiting", a, c) });
    pi.registerCommand("ticket-lifecycle-merged", { description: "Host/operator: consume local merge attestation", handler: (a, c) => command("merged", a, c) });
    pi.registerCommand("ticket-lifecycle-closed", { description: "Host/operator: consume local close attestation", handler: (a, c) => command("closed", a, c) });
    pi.registerTool({
      name: "delivery_controller_dispatch", label: "Dispatch picked-up work item",
      description: "Dispatches only the immutable work item resolved from an already picked-up opaque lifecycle handle. It never selects work, merges, or changes tracker status.", parameters: dispatchInput,
      async execute(_id, params, _signal, _update, context) {
        const config = validateControllerConfig(params.config as any, { trusted: context.isProjectTrusted(), mode: context.mode } as any);
        if (!config.ok) return { content: [{ type: "text", text: `Controller unavailable: ${(config as any).code}` }], details: config };
        try {
          const item = await lifecycle?.dispatchWorkItem((params as any).lifecycleHandle); if (!item) throw Object.assign(new Error("lifecycle_unavailable"), { code: "lifecycle_unavailable" });
          const { JobLedger } = await import("./ledger.mjs"); const { JulesAdapter } = await import("./jules-adapter.mjs"); const { JulesProvider } = await import("./jules-provider.mjs");
          const adapter = new JulesAdapter({ ledger: new JobLedger((params.config as any).ledgerPath), provider: new JulesProvider({ providerAuthEnvRef: (params as any).providerAuthEnvRef }) });
          const result = await adapter.dispatch({ ticket: item, idempotencyKey: (params as any).idempotencyKey, correlationId: (params as any).correlationId, approvalEnvRef: (params.config as any).approvalEnvRef, providerAuthEnvRef: (params as any).providerAuthEnvRef });
          return { content: [{ type: "text", text: "Dispatch recorded." }], details: result };
        } catch (error: any) { return { content: [{ type: "text", text: `Dispatch failed: ${error.code ?? "operation_failed"}` }], details: { ok: false, code: error.code ?? "operation_failed" } }; }
      },
    });
  });
  pi.on("session_shutdown", async (_event, ctx) => { try { await lifecycle?.shutdownReconcile(); } catch (error: any) { ctx?.ui?.notify?.(`Ticket lifecycle interruption recovery failed: ${error?.code ?? "operation_failed"}.`, "error"); } lifecycle = undefined; });
}
