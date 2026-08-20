#!/usr/bin/env node
/**
 * Export the canonical Lesson v1 structural schema to stdout only.
 *
 * This command intentionally has no filesystem output. Callers that need a
 * checked artifact may redirect stdout explicitly; the repository does not
 * commit contracts/lesson-v1.schema.json.
 */
import { LessonV1Schema, LESSON_V1_SCHEMA_ID, LESSON_V1_SCHEMA_VERSION } from "../contracts/lesson-v1.mjs";

const content = `${JSON.stringify(LessonV1Schema, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const parsed = JSON.parse(content);
  if (parsed.$id !== LESSON_V1_SCHEMA_ID || parsed.title !== "Versioned Lesson v1" || parsed.properties?.schema?.properties?.version?.const !== LESSON_V1_SCHEMA_VERSION) {
    throw new Error("Lesson v1 JSON Schema failed its self-check");
  }
}
process.stdout.write(content);
