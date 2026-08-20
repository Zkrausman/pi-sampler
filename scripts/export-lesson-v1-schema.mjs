import { LessonV1Schema } from "../contracts/lesson-v1.mjs";

// Deliberately stdout-only: callers choose whether and where to redirect this
// deterministic schema, so this command cannot follow a hostile filesystem path.
process.stdout.write(`${JSON.stringify(LessonV1Schema, null, 2)}\n`);
