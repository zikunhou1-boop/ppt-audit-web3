import fs from "fs";
import path from "path";

function readRules() {
  const p = path.join(process.cwd(), "rules", "rules.json");
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw);
}

function safeToString(x) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function decodeBasicEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function matchForbiddenTerms(text, terms) {
  const hits = [];
  for (const t of terms || []) {
    if (!t) continue;
    if (text.includes(t)) hits.push(t);
  }
  return hits;
}

function matchForbiddenPatterns(text, patterns) {
  const hits = [];
  for (const p of patterns || []) {
    if (!p) continue;
    try {
      const re = new RegExp(p);
      const m = text.match(re);
      if (m) hits.push(p);
    } catch {
      // ignore bad regex
    }
  }
  return hits;
}

function includesAny(text, arr) {
  for (const x of arr || []) {
    if (x && text.includes(x)) return true;
  }
  return false;
}

function findFirstAny(text, arr) {
  for (const x of arr || []) {
    if (x && text.includes(x)) return x;
  }
  return "";
}

function runAutoChecksOnPage(rule, pageNo, pageText) {
  const issues = [];
  const autoChecks = rule.auto_checks || [];

  for (const c of autoChecks) {
    if (!c || !c.type) continue;

    if (c.type === "forbidden_terms") {
      const hits = matchForbiddenTerms(pageText, c.terms);
      for (const h of hits) {
        issues.push({
          page: pageNo,
          rule_id: rule.id,
          severity: rule.severity || "medium",
          type: c.type,
          hit: h,
          reason: rule.title,
          suggestion: rule.instruction || "请按规则整改",
          message: c.fail_message || "命中禁用词"
        });
      }
    }

    if (c.type === "forbidden_patterns") {
      const hits = matchForbiddenPatterns(pageText, c.patterns);
      for (const h of hits) {
        issues.push({
          page: pageNo,
          rule_id: rule.id,
          severity: rule.severity || "medium",
          type: c.type,
          hit: h,
          reason: rule.title,
          suggestion: rule.instruction || "请按规则整改",
          message: c.fail_message || "命中禁用表达"
        });
      }
    }

    if (c.type === "must_have_any") {
      const ok = includesAny(pageText, c.patterns_any);
      if (!ok) {
        issues.push({
          page: pageNo,
          rule_id: rule.id,
          severity: rule.severity || "medium",
          type: c.type,
          hit: (c.patterns_any || []).slice(0, 3).join(" / "),
          reason: rule.title,
          suggestion: rule.instruction || "请按规则补齐",
          message: c.fail_message || "缺少必备提示"
        });
      }
    }

    if (c.type === "must_have_if_contains") {
      const triggered = includesAny(pageText, c.if_terms_any);
      if (triggered) {
        const ok = includesAny(pageText, c.must_terms_any);
        if (!ok) {
          issues.push({
            page: pageNo,
            rule_id: rule.id,
            severity: rule.severity || "medium",
            type: c.type,
            hit: `触发词：${findFirstAny(pageText, c.if_terms_any)}；缺少：${(c.must_terms_any || []).slice(0, 3).join(" / ")}`,
            reason: rule.title,
            suggestion: rule.instruction || "请按规则补齐",
            message: c.fail_message || "触发条件后缺少必备提示"
          });
        }
      }
    }
  }

  return issues;
}

function buildReviewReminders(rule) {
  if ((rule.mode || "").includes("REVIEW")) {
    return {
      rule_id: rule.id,
      severity: rule.severity || "medium",
      title: rule.title,
      review_points: rule.review_points || [],
      instruction: rule.instruction || ""
    };
  }
  return null;
}

function audit(pages, rulesDoc) {
  const rules = rulesDoc.rules || [];

  const normPages = (pages || []).map((p, idx) => ({
    page: Number.isFinite(p.page) ? p.page : idx + 1,
    content: decodeBasicEntities(safeToString(p.content))
  }));

  const issues = [];
  const review = [];

  for (const rule of rules) {
    // REVIEW 提示收集（不判定对错，只提示）
    const r = buildReviewReminders(rule);
    if (r) review.push(r);

    // 对每页跑 AUTO 检查
    for (const pg of normPages) {
      const autoIssues = runAutoChecksOnPage(rule, pg.page, pg.content);
      issues.push(...autoIssues);
    }
  }

  const hasHigh = issues.some((x) => x.severity === "high");
  const risk_level = hasHigh ? "high" : issues.length ? "medium" : "low";

  return {
    pass: issues.length === 0,
    risk_level,
    rule_version: rulesDoc.version || "",
    issues,
    review
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { pages } = req.body || {};
    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: "pages is required" });
    }

    const rulesDoc = readRules();
    const out = audit(pages, rulesDoc);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e), stack: e?.stack });
  }
}
