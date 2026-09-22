/**
 * Jev suggested-reply: fixed FAQ scripts first, then shop knowledge base.
 * Never auto-sends to end users — caller posts suggestions to staff topics only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ScriptEntry {
  id: string;
  keywords: string[];
  question?: string;
  answer: string;
}

export interface JevSuggestion {
  source: "script" | "knowledge" | "none";
  title?: string;
  answer: string;
  scriptId?: string;
}

export interface KnowledgeSection {
  title: string;
  body: string;
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultScriptsPath(): string {
  return (
    process.env.JEV_SCRIPTS_PATH?.trim() ||
    path.join(ROOT, "data", "scripts.json")
  );
}

function defaultKnowledgePath(): string {
  return (
    process.env.JEV_KNOWLEDGE_PATH?.trim() ||
    path.join(ROOT, "data", "knowledge.md")
  );
}

let scripts: ScriptEntry[] = [];
let sections: KnowledgeSection[] = [];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Meaningful terms for overlap scoring:
 * - Latin/digit words length >= 2
 * - CJK bigrams + trigrams (so continuous Chinese still overlaps section titles)
 * - short whole CJK runs (2–8 chars)
 */
function extractTerms(text: string): string[] {
  const n = normalize(text);
  const terms = new Set<string>();

  const latin = n.match(/[a-z0-9]{2,}/g);
  if (latin) for (const t of latin) terms.add(t);

  const cjkRuns = n.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length >= 2 && run.length <= 8) terms.add(run);
    for (let i = 0; i < run.length - 1; i++) {
      terms.add(run.slice(i, i + 2));
    }
    for (let i = 0; i < run.length - 2; i++) {
      terms.add(run.slice(i, i + 3));
    }
  }
  return [...terms];
}

function loadScripts(filePath: string): ScriptEntry[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`[jev] scripts file missing: ${filePath}`);
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    console.warn("[jev] scripts.json must be an array");
    return [];
  }
  return parsed
    .filter(
      (e): e is ScriptEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as ScriptEntry).id === "string" &&
        typeof (e as ScriptEntry).answer === "string" &&
        Array.isArray((e as ScriptEntry).keywords),
    )
    .map((e) => ({
      id: e.id,
      keywords: e.keywords.map(String),
      question: e.question ? String(e.question) : undefined,
      answer: e.answer,
    }));
}

function loadKnowledge(filePath: string): KnowledgeSection[] {
  if (!fs.existsSync(filePath)) {
    console.warn(`[jev] knowledge file missing: ${filePath}`);
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parts = raw.split(/^##\s+/m);
  const out: KnowledgeSection[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const nl = trimmed.indexOf("\n");
    const title = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
    const body = (nl === -1 ? "" : trimmed.slice(nl + 1)).trim();
    if (!title || !body) continue;
    out.push({ title, body });
  }
  return out;
}

export function reloadJevData(
  scriptsPath = defaultScriptsPath(),
  knowledgePath = defaultKnowledgePath(),
): void {
  scripts = loadScripts(scriptsPath);
  sections = loadKnowledge(knowledgePath);
  console.log(
    `[jev] loaded ${scripts.length} scripts, ${sections.length} knowledge sections`,
  );
}

function scoreScript(entry: ScriptEntry, userNorm: string): number {
  let score = 0;
  for (const kw of entry.keywords) {
    const k = normalize(kw);
    if (k && userNorm.includes(k)) score += 1;
  }
  if (entry.question) {
    const q = normalize(entry.question);
    if (q && userNorm.includes(q)) score += 1;
    else {
      for (const term of extractTerms(entry.question)) {
        if (userNorm.includes(term)) score += 0.5;
      }
    }
  }
  return score;
}

function scoreSection(section: KnowledgeSection, userTerms: string[]): number {
  const hay = normalize(`${section.title}\n${section.body}`);
  let score = 0;
  for (const t of userTerms) {
    if (hay.includes(t)) score += 1;
  }
  return score;
}

/**
 * Suggest a reply for staff review.
 * Prefer fixed scripts (score >= 1), else best knowledge section (overlap >= 1).
 */
export function suggest(userText: string): JevSuggestion | null {
  const text = (userText || "").trim();
  if (!text) return null;

  const userNorm = normalize(text);

  let bestScript: ScriptEntry | null = null;
  let bestScriptScore = 0;
  for (const entry of scripts) {
    const s = scoreScript(entry, userNorm);
    if (s > bestScriptScore) {
      bestScriptScore = s;
      bestScript = entry;
    }
  }
  if (bestScript && bestScriptScore >= 1) {
    return {
      source: "script",
      title: bestScript.question || bestScript.id,
      answer: bestScript.answer,
      scriptId: bestScript.id,
    };
  }

  const userTerms = extractTerms(text);
  if (userTerms.length === 0) return null;

  let bestSec: KnowledgeSection | null = null;
  let bestSecScore = 0;
  for (const sec of sections) {
    const s = scoreSection(sec, userTerms);
    if (s > bestSecScore) {
      bestSecScore = s;
      bestSec = sec;
    }
  }
  if (bestSec && bestSecScore >= 1) {
    return {
      source: "knowledge",
      title: bestSec.title,
      answer: bestSec.body,
    };
  }

  return null;
}

// Load once at import; callers may call reloadJevData() later.
reloadJevData();
