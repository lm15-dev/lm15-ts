/**
 * Regenerate `src/surface.ts` by reflection over the TypeScript compiler's
 * view of `src/types/*.ts`: every exported interface and class, with its
 * property names in the wire spelling (snake_case). TypeScript erases
 * types at runtime, so this is the reflection PROTOCOL.md asks for, run at
 * build time rather than at call time. Never edited by hand.
 *
 *     node --experimental-strip-types tools/gen_surface.ts
 */

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typesDir = join(root, "src", "types");
const files = readdirSync(typesDir)
  .filter((f) => f.endsWith(".ts") && f !== "validate.ts")
  .map((f) => join(typesDir, f));

const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  noEmit: true,
  strict: true,
});
const checker = program.getTypeChecker();

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const out: Record<string, string[]> = {};

for (const file of files) {
  const source = program.getSourceFile(file);
  if (!source) continue;
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) continue;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const declaration = exported.declarations?.[0];
    if (!declaration) continue;
    if (!ts.isInterfaceDeclaration(declaration) && !ts.isClassDeclaration(declaration)) continue;
    const name = exported.name;
    if (name.endsWith("Options") || name.endsWith("Input") || name.endsWith("Fields") || name === "ModelRegistry") continue;
    const type = checker.getDeclaredTypeOfSymbol(exported);
    const fields: string[] = [];
    for (const prop of checker.getPropertiesOfType(type)) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      if (!decl) continue;
      if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isGetAccessorDeclaration(decl)) continue;
      if (ts.isPropertyDeclaration(decl) && (decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)) continue;
      if (prop.name.startsWith("#") || prop.name.startsWith("_")) continue;
      fields.push(snake(prop.name));
    }
    if (fields.length > 0) out[name] = fields;
  }
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const body = `/**
 * The public type surface, by reflection over the TypeScript declarations
 * (\`tools/gen_surface.ts\` regenerates this file at build time from the
 * compiler's view of \`src/types/*.ts\`). Never edited by hand.
 */
export const SURFACE_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  ${JSON.stringify(sorted, null, 2).replace(/\n/g, "\n  ")} as Record<string, readonly string[]>,
);
`;
writeFileSync(join(root, "src", "surface.ts"), body);
console.log(`surface: ${Object.keys(sorted).length} types`);
