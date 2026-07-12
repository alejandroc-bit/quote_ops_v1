import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export type ForbiddenImportCheck = {
  rootDir: string;
  includeGlobs: string[];
  forbiddenFragments: string[];
  forbiddenExportsByModule?: Record<string, readonly string[]>;
};

type ImportMatch = {
  target: string;
  fragment: string;
};

type ImportReference = {
  kind: "import" | "export" | "dynamic-import" | "require";
  moduleSpecifier: string;
  importedNames: string[];
  exposesModuleNamespace: boolean;
};

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"] as const;
const declarationExtensions = [".d.ts", ".d.mts", ".d.cts"] as const;

export async function assertNoForbiddenImports(
  check: ForbiddenImportCheck
): Promise<true> {
  const files = await expandPaths(check.rootDir, check.includeGlobs);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const match = findForbiddenImport(
      file,
      text,
      check.forbiddenFragments,
      check.forbiddenExportsByModule
    );
    if (match) {
      const path = relative(check.rootDir, file) || file;
      throw new Error(
        `forbidden import fragment "${match.fragment}" found in ${path}: ${match.target}`
      );
    }
  }
  return true;
}

async function expandPaths(rootDir: string, paths: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const path of paths) {
    const expandedFiles = await expandPath(rootDir, path);
    if (expandedFiles.length === 0) {
      throw new Error(`architecture path matched no source files: ${path}`);
    }
    for (const file of expandedFiles) {
      files.add(file);
    }
  }
  return [...files].sort();
}

async function expandPath(rootDir: string, path: string): Promise<string[]> {
  if (!path.includes("*")) {
    const fullPath = join(rootDir, path);
    const info = await safeStat(fullPath);
    if (!info) {
      throw new Error(`architecture path missing: ${path}`);
    }
    if (info.isFile()) {
      return isTypeScriptSource(fullPath) ? [fullPath] : [];
    }
    if (info.isDirectory()) {
      return walkTypeScriptSources(fullPath);
    }
    return [];
  }

  const normalizedPath = path.split("/").join(sep);
  const baseDir = globBaseDir(rootDir, normalizedPath);
  const baseInfo = await safeStat(baseDir);
  if (!baseInfo) {
    throw new Error(`architecture path missing: ${path}`);
  }
  if (!baseInfo.isDirectory()) {
    return [];
  }

  const allFiles = await walkTypeScriptSources(baseDir);
  const pattern = globToRegExp(path.split(sep).join("/"));
  return allFiles.filter((file) => pattern.test(relative(rootDir, file).split(sep).join("/")));
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function walkTypeScriptSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTypeScriptSources(fullPath)));
      continue;
    }
    if (entry.isFile() && isTypeScriptSource(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function isTypeScriptSource(path: string): boolean {
  return (
    sourceExtensions.some((extension) => path.endsWith(extension)) &&
    !declarationExtensions.some((extension) => path.endsWith(extension))
  );
}

function findForbiddenImport(
  file: string,
  text: string,
  forbiddenFragments: readonly string[],
  forbiddenExportsByModule: ForbiddenImportCheck["forbiddenExportsByModule"] = {}
): ImportMatch | null {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let match: ImportMatch | null = null;

  function visit(node: ts.Node): void {
    if (match) return;

    const reference = importReference(node);
    if (reference) {
      match = findForbiddenReference(reference, forbiddenFragments, forbiddenExportsByModule);
      if (match) return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return match;
}

function importReference(node: ts.Node): ImportReference | null {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    const importClause = node.importClause;
    const namedBindings = importClause?.namedBindings;
    return {
      kind: "import",
      moduleSpecifier: node.moduleSpecifier.text,
      importedNames: importClauseTargets(importClause),
      exposesModuleNamespace:
        Boolean(importClause?.name) || Boolean(namedBindings && ts.isNamespaceImport(namedBindings))
    };
  }

  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    const exportClause = node.exportClause;
    return {
      kind: "export",
      moduleSpecifier: node.moduleSpecifier.text,
      importedNames: exportClauseTargets(exportClause),
      exposesModuleNamespace: !exportClause || ts.isNamespaceExport(exportClause)
    };
  }

  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const [firstArgument] = node.arguments;
    const moduleSpecifier = moduleSpecifierText(firstArgument);
    if (!moduleSpecifier) return null;

    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return {
        kind: "dynamic-import",
        moduleSpecifier,
        importedNames: [],
        exposesModuleNamespace: true
      };
    }

    if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
      return {
        kind: "require",
        moduleSpecifier,
        importedNames: [],
        exposesModuleNamespace: true
      };
    }
  }

  return null;
}

function moduleSpecifierText(expression: ts.Expression | undefined): string | null {
  if (!expression) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return null;
}

function findForbiddenReference(
  reference: ImportReference,
  forbiddenFragments: readonly string[],
  forbiddenExportsByModule: Record<string, readonly string[]>
): ImportMatch | null {
  const directTargets = [reference.moduleSpecifier, ...reference.importedNames];
  const fragment = forbiddenFragments.find((candidate) =>
    directTargets.some((target) => target.includes(candidate))
  );
  if (fragment) {
    return { target: reference.moduleSpecifier, fragment };
  }

  const forbiddenExports = forbiddenExportsByModule[reference.moduleSpecifier];
  if (!forbiddenExports || forbiddenExports.length === 0) {
    return null;
  }

  const importedForbiddenExport = reference.importedNames.find((name) =>
    forbiddenExports.includes(name)
  );
  if (importedForbiddenExport) {
    return { target: `${reference.moduleSpecifier}#${importedForbiddenExport}`, fragment: importedForbiddenExport };
  }

  if (reference.exposesModuleNamespace) {
    return {
      target: `${reference.moduleSpecifier} exposes ${forbiddenExports.join(", ")}`,
      fragment: reference.moduleSpecifier
    };
  }

  return null;
}

function importClauseTargets(importClause: ts.ImportClause | undefined): string[] {
  if (!importClause) return [];

  const targets: string[] = [];
  if (importClause.name) {
    targets.push(importClause.name.text);
  }

  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    targets.push(namedBindings.name.text);
  }
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      if (element.propertyName) targets.push(element.propertyName.text);
      targets.push(element.name.text);
    }
  }
  return targets;
}

function exportClauseTargets(exportClause: ts.ExportDeclaration["exportClause"]): string[] {
  if (!exportClause) return [];
  if (ts.isNamespaceExport(exportClause)) {
    return [exportClause.name.text];
  }

  const targets: string[] = [];
  for (const element of exportClause.elements) {
    if (element.propertyName) targets.push(element.propertyName.text);
    targets.push(element.name.text);
  }
  return targets;
}

function globBaseDir(rootDir: string, pattern: string): string {
  const wildcardIndex = searchWildcardIndex(pattern);
  const baseEnd = wildcardIndex === -1 ? pattern.length : pattern.lastIndexOf(sep, wildcardIndex);
  if (baseEnd === -1) return rootDir;
  const basePath = pattern.slice(0, baseEnd);
  return basePath ? join(rootDir, basePath) : rootDir;
}

function searchWildcardIndex(pattern: string): number {
  const starIndex = pattern.indexOf("*");
  const questionIndex = pattern.indexOf("?");
  if (starIndex === -1) return questionIndex;
  if (questionIndex === -1) return starIndex;
  return Math.min(starIndex, questionIndex);
}

function globToRegExp(pattern: string): RegExp {
  const normalizedPattern = pattern.split(sep).join("/");
  let source = "^";
  let index = 0;

  while (index < normalizedPattern.length) {
    if (normalizedPattern.slice(index, index + 3) === "**/") {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (normalizedPattern.slice(index, index + 2) === "**") {
      source += ".*";
      index += 2;
      continue;
    }

    const char = normalizedPattern[index];
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char) {
      source += escapeRegExp(char);
    }
    index += 1;
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
