/**
 * Learn-from-chats v1: append approved Q&A into scripts.json / knowledge.md.
 * No LLM — original question/answer text only. Paths follow JEV_* env like jev.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { reloadJevData, type ScriptEntry } from "./jev.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function scriptsPath(): string {
  return (
    process.env.JEV_SCRIPTS_PATH?.trim() ||
    path.join(ROOT, "data", "scripts.json")
  );
}

export function knowledgePath(): string {
  return (
    process.env.JEV_KNOWLEDGE_PATH?.trim() ||
    path.join(ROOT, "data", "knowledge.md")
  );
}

const MIN_QUESTION_LEN = 2;
const MIN_ANSWER_LEN = 4;
const MAX_KEYWORDS = 12;

export function passesLengthChecks(question: string, answer: string): boolean {
  return (
    question.trim().length >= MIN_QUESTION_LEN &&
    answer.trim().length >= MIN_ANSWER_LEN
  );
}

/**
 * Derive keywords from question: full string + latin tokens + CJK overlapping bigrams.
 * Cap ~8–12 entries.
 */
export function deriveKeywords(question: string): string[] {
  const q = question.trim();
  if (!q) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  const add = (s: string) => {
    const t = s.trim();
    if (!t || t.length < 2) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  add(q);

  const latin = q.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (latin) for (const t of latin) add(t);

  const cjkRuns = q.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length >= 2 && run.length <= 8) add(run);
    for (let i = 0; i < run.length - 1; i++) {
      add(run.slice(i, i + 2));
      if (out.length >= MAX_KEYWORDS) break;
    }
    if (out.length >= MAX_KEYWORDS) break;
  }

  return out.slice(0, MAX_KEYWORDS);
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

export function appendScriptEntry(
  question: string,
  answer: string,
): { id: string } {
  const filePath = scriptsPath();
  let list: ScriptEntry[] = [];
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("scripts.json must be a JSON array");
    }
    list = parsed as ScriptEntry[];
  }

  const short = randomBytes(4).toString("hex");
  const id = `learn-${short}`;
  const entry: ScriptEntry = {
    id,
    keywords: deriveKeywords(question),
    question: question.trim(),
    answer: answer.trim(),
  };
  list.push(entry);
  atomicWrite(filePath, `${JSON.stringify(list, null, 2)}\n`);
  reloadJevData();
  return { id };
}

export function appendKnowledgeSection(
  question: string,
  answer: string,
): { title: string } {
  const filePath = knowledgePath();
  const title = question.trim().slice(0, 30) || "学习条目";
  const block = `\n\n## ${title}\n\n${answer.trim()}\n`;
  if (fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, block, "utf8");
  } else {
    atomicWrite(filePath, `# 店铺知识库\n${block}`);
  }
  reloadJevData();
  return { title };
}

export function previewText(text: string, max = 40): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}
