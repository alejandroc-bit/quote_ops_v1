import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateCriteriaNode, type CriteriaNode } from "@quoteops/criteria";

const cache = new Map<string, { mtimeMs: number; nodes: CriteriaNode[] }>();

/**
 * Loads structured commercial-criteria nodes from every *.yaml/*.json in the
 * criteria dir. A file may be a top-level array of nodes or `{ nodes: [...] }`;
 * files that don't validate as criteria nodes (e.g. the human-facing
 * criteria-template.yaml) are skipped rather than failing the load. Re-reads
 * when the directory's newest mtime changes so the onboarding CLI can add
 * criteria without a restart.
 */
export async function loadCriteriaNodes(dir?: string): Promise<CriteriaNode[]> {
  if (!dir) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files = entries
    .filter((name) => /\.(ya?ml|json)$/i.test(name))
    .map((name) => join(dir, name))
    .sort();

  let newestMtime = 0;
  for (const file of files) {
    try {
      newestMtime = Math.max(newestMtime, (await stat(file)).mtimeMs);
    } catch {
      /* ignore unreadable entry */
    }
  }

  const cached = cache.get(dir);
  if (cached && cached.mtimeMs === newestMtime && files.length > 0) {
    return cached.nodes;
  }

  const nodes: CriteriaNode[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      const raw = await readFile(file, "utf8");
      parsed = file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch {
      continue;
    }
    const candidates = extractNodeCandidates(parsed);
    for (const candidate of candidates) {
      try {
        nodes.push(validateCriteriaNode(candidate));
      } catch {
        /* not a criteria node — skip (e.g. the commercial-criteria template) */
      }
    }
  }

  cache.set(dir, { mtimeMs: newestMtime, nodes });
  return nodes;
}

function extractNodeCandidates(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { nodes?: unknown }).nodes)) {
    return (parsed as { nodes: unknown[] }).nodes;
  }
  return [];
}
