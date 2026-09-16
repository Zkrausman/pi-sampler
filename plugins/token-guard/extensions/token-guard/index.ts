import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configFromFlags } from "../../src/config.ts";
import { TokenGuard } from "../../src/guard.ts";

export default function tokenGuardExtension(pi: ExtensionAPI): void {
  pi.registerFlag("token-guard", { description: "Detect repeated completed tool calls (opt-in)", type: "boolean", default: false });
  pi.registerFlag("token-guard-warn-after", { description: "Repeated completed signatures before warning", type: "string" });
  pi.registerFlag("token-guard-stop-after", { description: "Optionally abort after repeated-signature suspicion", type: "string" });

  const config = configFromFlags((name) => pi.getFlag(name));
  const guard = new TokenGuard(config);
  const reset = () => guard.reset();
  pi.on("session_start", reset);
  pi.on("agent_start", reset);
  pi.on("session_shutdown", reset);

  pi.on("tool_execution_start", (event) => {
    guard.start(event.toolCallId, event.toolName, event.args);
  });

  pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
    const decision = guard.complete(event.toolCallId, event.result);
    if (!decision.suspected) return;
    if (decision.warn && ctx.hasUI) {
      try { ctx.ui.notify("Token guard suspects repetitive tool behavior; changed evidence will reset this warning.", "warning"); } catch { /* UI is best effort in non-interactive hosts. */ }
    }
    if (decision.stop) ctx.abort();
  });
}
