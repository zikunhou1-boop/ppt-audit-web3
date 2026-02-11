// pages/index.js
import { useMemo, useState } from "react";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  // OCR 开关
  const [enableOCR, setEnableOCR] = useState(true);
  const [ocrStatus, setOcrStatus] = useState({ ok: false, msg: "未加载", progress: 0 });

  // 最终结果：pages + audit + aiReport + semantic
  const [result, setResult] = useState(null);

  // ✅ 新增：问题“合规解释/追问”缓存与加载态（不改变原有审核流程）
  const [explainMap, setExplainMap] = useState({});
  const [explainLoadingKey, setExplainLoadingKey] = useState("");

  // ---------- util ----------
  async function safeJson(resp) {
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { ok: false, http_status: resp.status, raw };
    }
  }

  function extOf(name) {
    const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function stripXmlText(xmlStr) {
    // 从 slide.xml 提取 <a:t> 文本
    if (!xmlStr) return "";
    const hits = [];
    const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xmlStr))) {
      const t = (m[1] || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (t) hits.push(t);
    }
    // 简单合并：同一行/段落
    return hits.join(" ");
  }

  function sortSlideFiles(files) {
    // ppt/slides/slide1.xml ... slideN.xml
    const arr = files.slice();
    arr.sort((a, b) => {
      const na = Number((a.match(/slide(\d+)\.xml$/) || [])[1] || 0);
      const nb = Number((b.match(/slide(\d+)\.xml$/) || [])[1] || 0);
      return na - nb;
    });
    return arr;
  }

  async function loadScriptAny(urls) {
    // 动态加载 CDN 脚本（不需要 npm install）
    for (const url of urls) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = url;
          s.async = true;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("load failed: " + url));
          document.head.appendChild(s);
        });
        return { ok: true, url };
      } catch {
        // try next
      }
    }
    return { ok: false };
  }

  async function ensureJSZip() {
    if (window.JSZip) return true;
    const r = await loadScriptAny([
      "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
      "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
    ]);
    return !!r.ok && !!window.JSZip;
  }

  async function ensureTesseract() {
    if (window.Tesseract) return true;
    setOcrStatus({ ok: false, msg: "加载 OCR 引擎中...", progress: 0 });
    const r = await loadScriptAny([
      "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
      "https://unpkg.com/tesseract.js@5/dist/tesseract.min.js",
    ]);
    const ok = !!r.ok && !!window.Tesseract;
    setOcrStatus({ ok, msg: ok ? "OCR 引擎已就绪" : "OCR 引擎加载失败（CDN 不可达）", progress: 0 });
    return ok;
  }

  function dedupeIssues(list) {
    // 规则/AI 输出去重：rule_id + page + quote0
    const out = [];
    const seen = new Set();
    for (const it of list || []) {
      const q0 = Array.isArray(it?.quote) && it.quote[0] ? String(it.quote[0]) : "";
      const key = `${it?.rule_id || ""}__${it?.page ?? ""}__${q0.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  // 判定“AI 是否生效”
  function isAiReportEffective(aiReportRaw) {
    if (!aiReportRaw || typeof aiReportRaw !== "object") return false;
    if (aiReportRaw.ok !== true) return false;
    if (!Array.isArray(aiReportRaw.rules_issues_fix) || aiReportRaw.rules_issues_fix.length === 0) return false;
    return true;
  }

  function normalizeAiReport(aiReportRaw) {
    if (!aiReportRaw || typeof aiReportRaw !== "object") return null;

    if (aiReportRaw?.final_summary && Array.isArray(aiReportRaw?.rules_issues_fix)) {
      return {
        ok: aiReportRaw.ok === true,
        final_summary: aiReportRaw.final_summary,
        rules_issues_fix: dedupeIssues(aiReportRaw.rules_issues_fix),
        ai_extra: Array.isArray(aiReportRaw.ai_extra) ? aiReportRaw.ai_extra : [],
      };
    }

    // 兼容旧结构：{ ai: [...] }
    const legacy = aiReportRaw?.ai;
    if (Array.isArray(legacy)) {
      return {
        ok: true,
        final_summary: { overall: "", top_risks: [], next_actions: [] },
        rules_issues_fix: dedupeIssues(
          legacy.map((x) => ({
            rule_id: x.rule_id,
            page: x.page ?? null,
            quote: Array.isArray(x.quote) ? x.quote.slice(0, 3) : [],
            problem: x.problem || "",
            rewrite: Array.isArray(x.rewrite_suggestion)
              ? x.rewrite_suggestion.slice(0, 3).map((r) => ({
                  action: r.action || "修改/补充",
                  before: r.before || "",
                  after: r.after || "",
                }))
              : [],
            note: x.notes || "",
          }))
        ),
        ai_extra: [],
      };
    }

    return null;
  }

  // ✅ 新增：为“合规解释/追问”生成 key（不影响原有 mustFix 去重逻辑）
  function explainKeyOf(it, idx) {
    const q0 = Array.isArray(it?.quote) && it.quote[0] ? String(it.quote[0]) : "";
    return `${it?.rule_id || ""}__${it?.page ?? ""}__${idx}__${q0.slice(0, 60)}`;
  }

  // ✅ 新增：调用后端 /api/ai_explain（你需要已创建 pages/api/ai_explain.js）
  async function onExplain(it, idx) {
    const k = explainKeyOf(it, idx);
    if (explainMap[k]) return; // 已缓存
    setExplainLoadingKey(k);

    try {
      const payload = {
        item: {
          rule_id: it?.rule_id || "",
          page: it?.page ?? null,
          quote: Array.isArray(it?.quote) ? it.quote.slice(0, 3) : [],
          problem: it?.problem || "",
          rewrite: Array.isArray(it?.rewrite) ? it.rewrite.slice(0, 3) : [],
          note: it?.note || "",
          kind: it?.kind || "",
        },
      };

      const r = await fetch("/api/ai_explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const j = await safeJson(r);
      setExplainMap((m) => ({ ...m, [k]: j }));
    } catch (e) {
      setExplainMap((m) => ({ ...m, [k]: { ok: false, error: String(e?.message || e) } }));
    } finally {
      setExplainLoadingKey("");
    }
  }

  // ---------- PPTX: browser extract ----------
  async function extractFromPptxBrowser(pptxFile, doOCR) {
    const okZip = await ensureJSZip();
    if (!okZip) {
      return { ok: false, error: "JSZip 加载失败（网络/CDN不可达）" };
    }

    const buf = await pptxFile.arrayBuffer();
    const zip = await window.JSZip.loadAsync(buf);

    // slides
    const slideFiles = [];
    zip.forEach((relativePath) => {
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(relativePath)) slideFiles.push(relativePath);
    });

    const slides = [];
    for (const f of sortSlideFiles(slideFiles)) {
      const xml = await zip.file(f).async("string");
      slides.push(stripXmlText(xml));
    }

    const pages = slides.map((t, idx) => ({ page: idx + 1, content: t || "" }));

    // images
    let ocrText = "";
    if (doOCR) {
      const okOcr = await ensureTesseract();
      if (!okOcr) {
        return { ok: true, pages, ocrText: "", ocrOk: false, ocrError: "OCR 引擎加载失败（CDN不可达）" };
      }

      // 收集图片：ppt/media/*
      const mediaFiles = [];
      zip.forEach((relativePath) => {
        if (/^ppt\/media\/.+\.(png|jpg|jpeg)$/i.test(relativePath)) mediaFiles.push(relativePath);
      });

      // 按文件大小排序，优先识别“大图”
      const mediaWithSize = [];
      for (const f of mediaFiles) {
        const fileObj = zip.file(f);
        if (!fileObj) continue;
        const ab = await fileObj.async("arraybuffer");
        mediaWithSize.push({ path: f, size: ab.byteLength, ab });
      }
      mediaWithSize.sort((a, b) => b.size - a.size);

      // 分批：每批 30 张
      const batchSize = 30;
      const total = mediaWithSize.length;

      let allTexts = [];
      for (let i = 0; i < total; i += batchSize) {
        const batch = mediaWithSize.slice(i, i + batchSize);

        for (let j = 0; j < batch.length; j++) {
          const idxGlobal = i + j + 1;
          const item = batch[j];

          setOcrStatus((s) => ({
            ok: true,
            msg: `OCR 识别中：${idxGlobal}/${total}`,
            progress: total ? Math.round((idxGlobal / total) * 100) : 0,
          }));

          try {
            const blob = new Blob([item.ab], {
              type: "image/" + (item.path.toLowerCase().endsWith(".png") ? "png" : "jpeg"),
            });
            const url = URL.createObjectURL(blob);

            // eslint-disable-next-line no-undef
            const r = await window.Tesseract.recognize(url, "chi_sim+eng", {
              logger: () => {},
            });

            URL.revokeObjectURL(url);

            const txt = (r?.data?.text || "").trim();
            if (txt && txt.length >= 6) {
              allTexts.push(`【图片OCR#${idxGlobal} ${item.path.split("/").pop()}】\n${txt}`);
            }
          } catch {
            // 忽略单张失败
          }
        }
      }

      setOcrStatus({ ok: true, msg: total ? `OCR 完成：${total} 张` : "OCR：无图片", progress: 100 });
      ocrText = allTexts.join("\n\n");
    }

    return { ok: true, pages, ocrText, ocrOk: true };
  }

  // ---------- run ----------
  async function onRun() {
    if (!file) {
      alert("请先选择文件（推荐 PPTX）");
      return;
    }

    setLoading(true);
    setResult(null);
    setExplainMap({}); // ✅ 不改变原逻辑，只是清空解释缓存
    setExplainLoadingKey("");
    setOcrStatus((s) => ({ ...s, progress: 0 }));

    try {
      const ext = extOf(file.name);

      let pages = [];
      let ocrText = "";

      if (ext === "pptx") {
        const r = await extractFromPptxBrowser(file, !!enableOCR);
        if (!r.ok) {
          setResult({ stage: "error", message: "提取失败", detail: r });
          return;
        }
        pages = r.pages || [];
        ocrText = r.ocrText || "";
      } else if (ext === "txt") {
        const txt = await file.text();
        pages = [{ page: 1, content: txt }];
      } else if (ext === "docx" || ext === "ppt") {
        setResult({
          stage: "error",
          message: "当前版本不支持在浏览器里解析 DOCX/PPT。请先另存为 PPTX 再上传。",
        });
        return;
      } else {
        setResult({ stage: "error", message: "不支持的文件类型（请用 .pptx/.txt）" });
        return;
      }

      if (!Array.isArray(pages) || pages.length === 0) {
        setResult({ stage: "error", message: "提取失败：未获取到页面内容（PPTX 可能无文本层）" });
        return;
      }

      // 合并全文（含 OCR）
      const pagesText = pages
        .map((p) => `【第${p.page}页】\n${p.content || ""}`)
        .join("\n\n");

      const fullText = ocrText ? `${pagesText}\n\n【图片OCR文本】\n${ocrText}` : pagesText;

      // 1) Rules Audit（必用 rules/rules.json）
      const r2 = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages }),
      });
      const audit = await safeJson(r2);

      if (!audit || typeof audit !== "object") {
        setResult({ stage: "error", message: "规则审核失败：返回异常", detail: audit });
        return;
      }

      // 2) 取 rulesJson（给 AI 用）
      let rulesJson = "";
      let rulesOk = false;
      try {
        const rr = await fetch("/api/rules");
        const j = await safeJson(rr);
        rulesJson = j?.rulesJson || "";
        rulesOk = typeof rulesJson === "string" && rulesJson.trim().length > 0;
      } catch {
        rulesJson = "";
        rulesOk = false;
      }

      // 3) AI report（融合整改）
      const r3 = await fetch("/api/ai_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "report",
          pagesText: fullText,
          audit,
          rulesJson,
        }),
      });

      const aiReportRaw = await safeJson(r3);
      const aiReport = normalizeAiReport(aiReportRaw);
      const aiUsed = isAiReportEffective(aiReportRaw);

      // 4) AI semantic（全篇语义扫描：只要 high 必改）
     const r4 = await fetch("/api/ai_review", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "semantic",
    scene: "internal_training",
    pagesText: fullText,
    audit,
    rulesJson,
  }),
});
      const semanticRaw = await safeJson(r4);

      const semanticHighMust = Array.isArray(semanticRaw?.semantic_extra)
        ? semanticRaw.semantic_extra.filter((x) => x?.severity === "high" && x?.must_fix === true)
        : [];

      // 统一成“必须修改问题”清单：report 的 rules_issues_fix + semantic high
      const mustFix = [];

      if (aiUsed && Array.isArray(aiReport?.rules_issues_fix)) {
        for (const it of aiReport.rules_issues_fix) {
          mustFix.push({
            kind: "rule",
            rule_id: it.rule_id,
            page: it.page,
            quote: it.quote,
            problem: it.problem,
            rewrite: it.rewrite,
            note: it.note,
          });
        }
      }

      for (const x of semanticHighMust) {
        mustFix.push({
          kind: "semantic",
          rule_id: "语义高风险",
          page: x.page ?? null,
          quote: Array.isArray(x.quote) ? x.quote : [],
          problem: `${x.problem || ""}${x.why_high ? `（原因：${x.why_high}）` : ""}`,
          rewrite: [{ action: "替换/修改", before: (x.quote && x.quote[0]) || "", after: x.fix || "" }],
          note: "",
        });
      }

      // 去重（防止 semantic 与 report 内容撞车）
      const mustFixDedup = dedupeIssues(
        mustFix.map((m) => ({
          rule_id: m.rule_id,
          page: m.page,
          quote: m.quote,
          problem: m.problem,
          rewrite: m.rewrite,
          note: m.note,
        }))
      ).map((x) => ({
        kind: x.rule_id === "语义高风险" ? "semantic" : "rule",
        ...x,
      }));

      setResult({
        stage: "done",
        pagesCount: pages.length,
        hasOCRText: !!ocrText,
        audit,
        rulesOk,
        aiUsed,
        aiHttpStatus: r3.status,
        aiRaw: aiReportRaw,
        aiReport,
        semanticOk: semanticRaw?.ok === true,
        semanticRaw,
        mustFix: mustFixDedup,
      });
    } catch (e) {
      setResult({ stage: "error", message: "客户端异常", detail: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  // ---------- UI ----------
  const auditPass = result?.audit?.pass === true;
  const riskLevel = result?.audit?.risk_level || "unknown";
  const mustFixList = Array.isArray(result?.mustFix) ? result.mustFix : [];

  const title = useMemo(() => "课件合规检查", []);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.headerRow}>
          <div>
            <div style={styles.h1}>{title}</div>
            <div style={styles.sub}>规则检测 + AI 复核 + 图片 OCR </div>
          </div>
        </div>

        <div style={styles.uploader}>
          <input
            type="file"
            accept=".pptx,.txt"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={styles.file}
          />

          <div style={styles.row}>
            <label style={styles.switchRow}>
              <input type="checkbox" checked={enableOCR} onChange={(e) => setEnableOCR(e.target.checked)} />
              <span style={{ marginLeft: 8 }}>启用图片 OCR </span>
            </label>

            <button onClick={onRun} disabled={loading} style={styles.btn}>
              {loading ? "处理中..." : "开始检查"}
            </button>
          </div>

          <div style={styles.meta}>
            推荐：PPTX。DOCX/PPT 请先另存为 PPTX。{enableOCR ? "（OCR 会识别 PPTX 内图片）" : ""}
          </div>

          {enableOCR && (
            <div style={styles.ocrBar}>
              <div style={styles.ocrText}>{ocrStatus.msg}</div>
              <div style={styles.progressWrap}>
                <div style={{ ...styles.progress, width: `${ocrStatus.progress || 0}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* result */}
      <div style={{ ...styles.card, marginTop: 14 }}>
        {!result && <div style={styles.empty}>上传 PPTX 后点击“开始检查”。</div>}

        {result?.stage === "error" && (
          <div style={styles.errBox}>
            <div style={styles.errTitle}>失败</div>
            <div style={styles.pre}>{result.message || "（无）"}</div>
            {result.detail ? <div style={{ ...styles.pre, opacity: 0.85 }}>{JSON.stringify(result.detail, null, 2)}</div> : null}
          </div>
        )}

        {result?.stage === "done" && (
          <>
            <div style={styles.topLine}>
              <span style={styles.badge}>{auditPass ? "规则：通过" : "规则：不通过"}</span>
              <span style={{ ...styles.badge, opacity: 0.8 }}>风险：{riskLevel}</span>
              <span style={{ ...styles.badge, opacity: 0.8 }}>
                页数：{result.pagesCount || 0}
                {result.hasOCRText ? "（含OCR）" : ""}
              </span>
            </div>

            <div style={styles.smallLine}>
              <span>AI 复核：{result.aiUsed ? "已生效" : `未生效（HTTP ${result.aiHttpStatus}）`}</span>
              <span style={{ margin: "0 8px", opacity: 0.5 }}>·</span>
              <span>规则库：{result.rulesOk ? "正常" : "异常"}</span>
              <span style={{ margin: "0 8px", opacity: 0.5 }}>·</span>
              <span>语义扫描：{result.semanticOk ? "已运行（仅显示高风险必改）" : "未运行"}</span>
            </div>

            {/* AI 未生效原因（精简显示） */}
            {!result.aiUsed && result.aiRaw?.error && (
              <div style={styles.hintBox}>
                <div style={styles.hintTitle}>AI 未生效原因</div>
                <div style={styles.pre}>{result.aiRaw.error || result.aiRaw.detail || "（无）"}</div>
              </div>
            )}

            {/* summary */}
            {result.aiUsed && result.aiReport?.final_summary ? (
              <div style={styles.summaryBox}>
                <div style={styles.sectionTitle}>摘要</div>
                <div style={styles.pre}>{result.aiReport.final_summary.overall || "（无）"}</div>
              </div>
            ) : null}

            {/* MUST FIX */}
            <div style={styles.sectionTitle}>必须修改的问题（高风险）</div>
            {mustFixList.length === 0 ? (
              <div style={styles.empty}>（无）</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {mustFixList.map((it, idx) => {
                  const k = explainKeyOf(it, idx);
                  const exp = explainMap[k];
                  const expOk = exp && exp.ok === true;
                  const expErr = exp && exp.ok === false;
                  const btnBusy = explainLoadingKey === k;

                  return (
                    <details key={idx} style={styles.itemCard}>
                      <summary style={styles.summaryRow}>
                        <div style={styles.itemTitle}>
                          #{idx + 1} · {it.rule_id} · 第{it.page ?? "?"}页
                          <span style={styles.tag}>{it.kind === "semantic" ? "语义扫描" : "规则+复核"}</span>
                        </div>
                      </summary>

                      {Array.isArray(it.quote) && it.quote.length > 0 ? (
                        <div style={{ marginTop: 8 }}>
                          <div style={styles.label}>定位原文</div>
                          <div style={styles.pre}>{it.quote.slice(0, 2).join("\n")}</div>
                        </div>
                      ) : null}

                      {it.problem ? (
                        <div style={{ marginTop: 8 }}>
                          <div style={styles.label}>问题</div>
                          <div style={styles.pre}>{it.problem}</div>
                        </div>
                      ) : null}

                      {Array.isArray(it.rewrite) && it.rewrite.length > 0 ? (
                        <div style={{ marginTop: 8 }}>
                          <div style={styles.label}>建议改写</div>
                          <div style={styles.rewriteBox}>
                            <div style={styles.rewriteCol}>
                              <div style={styles.rewriteLabel}>before</div>
                              <div style={styles.pre}>{it.rewrite[0]?.before || ""}</div>
                            </div>
                            <div style={styles.rewriteCol}>
                              <div style={styles.rewriteLabel}>after</div>
                              <div style={{ ...styles.pre, fontWeight: 700 }}>{it.rewrite[0]?.after || ""}</div>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {/* ✅ 新增：合规解释/追问（不改变原有 mustFix 展示逻辑） */}
                      <div style={styles.explainRow}>
                        <button
                          onClick={(e) => {
                            e.preventDefault(); // 防止 details 被点击时反复折叠
                            onExplain(it, idx);
                          }}
                          disabled={btnBusy}
                          style={{ ...styles.ghostBtn, opacity: btnBusy ? 0.6 : 1 }}
                        >
                          {expOk ? "已生成解释" : btnBusy ? "生成中..." : "合规解释 / 追问"}
                        </button>

                        {expErr ? <span style={styles.explainErr}>解释失败：{exp.error || exp.detail || "未知错误"}</span> : null}
                      </div>

                      {expOk ? (
                        <div style={styles.explainBox}>
                          <div style={styles.explainTitle}>{exp.title || "合规解释"}</div>

                          <div style={{ marginTop: 10 }}>
                            <div style={styles.label}>为何有风险</div>
                            <ul style={styles.ul}>
                              {(exp.why_risky || []).slice(0, 6).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                              {(!exp.why_risky || exp.why_risky.length === 0) && <li>（无）</li>}
                            </ul>
                          </div>

                          <div style={{ marginTop: 10 }}>
                            <div style={styles.label}>触发点（基于原文）</div>
                            <ul style={styles.ul}>
                              {(exp.what_triggered || []).slice(0, 6).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                              {(!exp.what_triggered || exp.what_triggered.length === 0) && <li>（无）</li>}
                            </ul>
                          </div>

                          <div style={{ marginTop: 10 }}>
                            <div style={styles.label}>怎么改（执行要点）</div>
                            <ul style={styles.ul}>
                              {(exp.how_to_fix || []).slice(0, 6).map((x, i) => (
                                <li key={i}>{x}</li>
                              ))}
                              {(!exp.how_to_fix || exp.how_to_fix.length === 0) && <li>（无）</li>}
                            </ul>
                          </div>

                          <div style={{ marginTop: 10 }}>
                            <div style={styles.label}>更合规的替代表述</div>
                            <ul style={styles.ul}>
                              {(exp.better_wording || []).slice(0, 6).map((x, i) => (
                                <li key={i} style={{ whiteSpace: "pre-wrap" }}>
                                  {x}
                                </li>
                              ))}
                              {(!exp.better_wording || exp.better_wording.length === 0) && <li>（无）</li>}
                            </ul>
                          </div>

                          {exp.notes ? (
                            <div style={{ marginTop: 10 }}>
                              <div style={styles.label}>备注</div>
                              <div style={styles.pre}>{exp.notes}</div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </details>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- minimal UI ----------
const styles = {
  page: {
    maxWidth: 980,
    margin: "24px auto",
    padding: 16,
    fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial',
    color: "#111",
  },
  card: {
    border: "1px solid #eee",
    borderRadius: 16,
    padding: 16,
    background: "#fff",
    boxShadow: "0 8px 30px rgba(0,0,0,0.04)",
  },
  headerRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  h1: { fontSize: 20, fontWeight: 800, letterSpacing: 0.2 },
  sub: { marginTop: 6, fontSize: 13, color: "#666" },

  uploader: { marginTop: 12 },
  file: { width: "100%" },
  row: { display: "flex", gap: 12, alignItems: "center", marginTop: 12 },
  switchRow: { display: "flex", alignItems: "center", fontSize: 13, color: "#333" },
  btn: {
    marginLeft: "auto",
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #ddd",
    background: "#111",
    color: "#fff",
    cursor: "pointer",
  },
  meta: { marginTop: 10, fontSize: 12, color: "#777" },

  ocrBar: { marginTop: 10, padding: 10, borderRadius: 12, background: "#fafafa", border: "1px solid #eee" },
  ocrText: { fontSize: 12, color: "#555" },
  progressWrap: { height: 8, background: "#eee", borderRadius: 999, marginTop: 8, overflow: "hidden" },
  progress: { height: 8, background: "#111" },

  empty: { color: "#777", fontSize: 13 },

  errBox: { border: "1px solid #f3caca", background: "#fff5f5", borderRadius: 14, padding: 12 },
  errTitle: { fontWeight: 800, marginBottom: 6 },
  pre: { whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 },

  topLine: { display: "flex", gap: 8, alignItems: "center", marginBottom: 10 },
  badge: { fontSize: 12, padding: "6px 10px", borderRadius: 999, border: "1px solid #eee", background: "#fafafa" },
  smallLine: { fontSize: 12, color: "#666", marginBottom: 12 },

  hintBox: { padding: 12, borderRadius: 14, border: "1px solid #eee", background: "#fafafa", marginBottom: 12 },
  hintTitle: { fontWeight: 800, marginBottom: 6 },

  summaryBox: { padding: 12, borderRadius: 14, border: "1px solid #eee", background: "#fff", marginBottom: 12 },
  sectionTitle: { fontWeight: 900, margin: "12px 0 10px", fontSize: 14 },

  itemCard: { border: "1px solid #eee", borderRadius: 14, padding: 12, background: "#fff" },
  summaryRow: { cursor: "pointer", listStyle: "none" },
  itemTitle: { fontWeight: 900, fontSize: 13, display: "flex", gap: 8, alignItems: "center" },
  tag: {
    marginLeft: "auto",
    fontSize: 12,
    color: "#666",
    border: "1px solid #eee",
    padding: "4px 8px",
    borderRadius: 999,
    background: "#fafafa",
  },
  label: { fontSize: 12, color: "#666", marginBottom: 6 },

  rewriteBox: { display: "flex", gap: 10, flexWrap: "wrap" },
  rewriteCol: { flex: "1 1 360px", border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fafafa" },
  rewriteLabel: { fontSize: 12, color: "#666", marginBottom: 6 },

  // ✅ explain UI（新增，不影响你现有视觉）
  explainRow: { display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" },
  ghostBtn: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid #ddd",
    background: "#fff",
    cursor: "pointer",
    fontSize: 13,
  },
  explainErr: { fontSize: 12, color: "#b42318" },
  explainBox: { marginTop: 12, paddingTop: 12, borderTop: "1px dashed #e6e6e6" },
  explainTitle: { fontWeight: 900, fontSize: 13 },
  ul: { margin: "6px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.55 },
};
