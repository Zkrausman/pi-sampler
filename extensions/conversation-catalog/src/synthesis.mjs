import { generateCitedHindsightDocumentHtml } from "./evidence.mjs";

export function buildHindsightDocument(sources) {
  const usable = (Array.isArray(sources) ? sources : []).filter((source) => !source.excluded && source.events?.length);
  if (usable.length < 2) throw new Error("Select at least two included conversations.");
  const evidence = usable.flatMap((source) => source.events.map((event) => ({ reference: event.evidence.reference, context: event.summary })));
  const claims = usable.map((source) => ({
    statement: `Selected conversation contains ${source.events.length} inspectable event${source.events.length === 1 ? "" : "s"}.`,
    classification: "direct evidence",
    evidenceReferences: [source.events[0].evidence.reference],
  }));
  return generateCitedHindsightDocumentHtml({ title: `Hindsight document — ${usable.length} selected conversations`, claims, evidence });
}
