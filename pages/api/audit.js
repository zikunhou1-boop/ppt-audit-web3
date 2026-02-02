import fs from "fs";
import path from "path";

function readRules() {
  const p = path.join(process.cwd(), "rules", "rules.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function includesAny(text, arr = []) {
  return arr.some((x) => x && text.includes(x));
}

function runAudit(pages, rulesDoc) {
  const rules = rulesDoc.rules || [];
  const issues = [];

  const pageTexts = (pages || []).map((p, idx) => ({
    page: Number.isFinite(p.page) ? p.page : idx + 1,
    text: String(p.content || "")
  }));
  const fullText = pageTexts.map((p) => p.text).join("\n\n");

  for (const r of rules) {
    if (r.type === "forbidden_terms") {
      for (const p of pageTexts) {
        const hit = (r.terms || []).find((t) => t && p.text.includes(t));
        if (hit) {
          issues.push({
            page: p.page,
            rule_id: r.id,
            excerpt: hit,
            reason: r.title,
            suggestion: r.instruction || "请按规则整改"
          });
        }
      }
    }

    if (r.type === "must_have_any") {
      const ok = includesAny(fullText, r.patterns_any || []);
      if (!ok) {
        issues.push({
          page: 0,
          rule_id: r.id,
          excerpt: (r.patterns_any || []).slice(0, 3).join(" / "),
          reason: r.title,
          suggestion: r.instruction || "请按规则补齐"
        });
      }
    }
  }

  const severityOf = (id) => (rules.find((x) => x.id === id)?.severity || "low");
  const risk_level = issues.some((x) => severityOf(x.rule_id) === "high")
    ? "high"
    : issues.length
    ? "medium"
    : "low";

  return {
    pass: issues.length === 0,
    risk_level,
    rule_version: rulesDoc.version,
    issues
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { pages } = req.body || {};
  if (!Array.isArray(pages) || pages.length === 0) {
    return res.status(400).json({ error: "pages is required" });
  }

  const rulesDoc = readRules();
  const out = runAudit(pages, rulesDoc);
  return res.status(200).json(out);
}
