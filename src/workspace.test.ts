// @ts-ignore Node-only test.
import assert from "node:assert/strict";
// @ts-ignore Node-only test.
import { readFileSync } from "node:fs";
// @ts-ignore Node-only test.
import { runInNewContext } from "node:vm";
import ts from "typescript";
const source = ts.createSourceFile("main.ts", readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "loadWorkspace")!;
const code = ts.transpileModule(fn.getText(source) + "; loadWorkspace()", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const raw of ["{broken", "null", "[]", '"workspace"']) {
  await assert.rejects(runInNewContext(code, { invoke: async () => raw }), undefined, `preserve invalid workspace: ${raw}`);
}
await assert.rejects(runInNewContext(code, { invoke: async () => { throw Error("access denied"); } }), /access denied/);
assert.equal(JSON.stringify(await runInNewContext(code, { invoke: async () => '\uFEFF{"threads":[]}' })), '{"threads":[]}');
console.log("ok   Workspace parse/read errors cannot become an empty saved workspace");
