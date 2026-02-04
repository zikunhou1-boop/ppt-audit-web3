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

/**
 * 判断某条 rule + auto_check 是否应当“全局检查一次”
 * 优先：rules.json 里在 auto_checks 里设置 scope: "global"
 * 兼容：rule_id 为 6-01 / 7-03 的 must_have_any 默认视为 global（避免刷屏）
 */
function isGlobalCheck(rule, check) {
  if (!check) return false;
  if (check.scope === "global") return true;

  // 兼容默认：这两条通常只要求全文出现一次即可
  if (check.type === "must_have_any" && (rule.id === "6-01" || rule.id === "7-03")) {
    return true;
  }
  return false;
}

function makeIssue(rule, pageNo, check, hitText, messageOverride) {
  return {
    page: pageNo,
    rule_id: rule.id,
    severity: rule.severity || "medium",
    type: check.type,
    hit: hitText || "",
    reason: rule.title,
    suggestion: rule.instruction || "请按规则整改",
    message: messageOverride || check.fail_message || "触发规则"
  };
}

/**
 * 对单页运行自动检查（不含 global）
 */
function runAutoChecksOnPage(rule, pageNo, pageText) {
  const issues = [];
  const autoChecks = rule.auto_checks || [];

  for (const c of autoChecks) {
    if (!c || !c.type) continue;
    // global 的检查不在这里跑
    if (isGlobalCheck(rule, c)) continue;

    if (c.type === "forbidden_terms") {
      const hits = matchForbiddenTerms(pageText, c.terms);
      for (const h of hits) {
        issues.push(makeIssue(rule, pageNo, c, h, c.fail_message || "命中禁用词"));
      }
    }

    if (c.type === "forbidden_patterns") {
      const hits = matchForbiddenPatterns(pageText, c.patterns);
      for (const h of hits) {
        issues.push(makeIssue(rule, pageNo, c, h, c.fail_message || "命中禁用表达"));
      }
    }

    if (c.type === "must_have_any") {
      const ok = includesAny(pageText, c.patterns_any);
      if (!ok) {
        issues.push(
          makeIssue(
            rule,
            pageNo,
            c,
            (c.patterns_any || []).slice(0, 3).join(" / "),
            c.fail_message || "缺少必备提示"
          )
        );
      }
    }

    if (c.type === "must_have_if_contains") {
      const triggered = includesAny(pageText, c.if_terms_any);
      if (triggered) {
        const ok = includesAny(pageText, c.must_terms_any);
        if (!ok) {
          issues.push(
            makeIssue(
              rule,
              pageNo,
              c,
              `触发词：${findFirstAny(pageText, c.if_terms_any)}；缺少：${(c.must_terms_any || [])
                .slice(0, 3)
                .join(" / ")}`,
              c.fail_message || "触发条件后缺少必备提示"
            )
          );
        }
      }
    }
  }

  return issues;
}

/**
 * 全局检查：只输出一次 issue（page=1）
 * 目前只处理 must_have_any（你最需要的 6-01、7-03 属于它）
 */
function runGlobalChecks(rule, fullText) {
  const issues = [];
  const autoChecks = rule.auto_checks || [];
  for (const c of autoChecks) {
    if (!c || !c.type) continue;
    if (!isGlobalCheck(rule, c)) continue;

    if (c.type === "must_have_any") {
      const ok = includesAny(fullText, c.patterns_any);
      if (!ok) {
        issues.push(
          makeIssue(
            rule,
            1,
            c,
            (c.patterns_any || []).slice(0, 3).join(" / "),
            // message 更准确一些：全文缺失
            c.fail_message ? `全文未发现：${c.fail_message}` : "全文缺少必备提示"
          )
        );
      }
    }

    // 如未来你想 global 禁用词/正则，也可以在这里扩展
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

  // 全文合并（用于 global 检查）
  const fullText = normPages.map((p) => p.content || "").join("\n");

  const issues = [];
  const review = [];

  for (const rule of rules) {
    // REVIEW 提示收集（不判定对错，只提示）
    const r = buildReviewReminders(rule);
    if (r) review.push(r);

    // 1) 先跑全局检查（只输出一次）
    issues.push(...runGlobalChecks(rule, fullText));

    // 2) 再对每页跑非全局检查
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
