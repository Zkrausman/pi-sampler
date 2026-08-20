import { Compile } from "typebox/compile";
import { LessonV1Schema } from "../contracts/lesson-v1.mjs";

// Deliberately no filesystem imports or writes. Callers may redirect stdout to
// a path they control without giving this script an opportunity to follow a
// symlink or overwrite a repository file.
Compile(LessonV1Schema);
process.stdout.write(`${JSON.stringify(LessonV1Schema, null, 2)}\n`);
