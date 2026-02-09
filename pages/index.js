// pages/index.js
import { useMemo, useState } from "react";
import Script from "next/script";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  // libs ready (CDN)
  const [zipReady, setZipReady] = useState(false);
  const [ocrReady, setOcrReady] = useState(false);

  // options
  const [enableOcr, setEnableOcr] = useState(true);
  const [batchSize, setBatchSize] = useState(30); // 每批图片数量
  const [maxImages, setMaxImages] = useState(120); // 最大处理图片数量（防止卡死）
  const [onlyLikelyText, setOnlyLikelyText] = useState(true); // 仅识别“疑似含字图片”
  const [ocrConcurrency, setOcrConcurrency] = useState(2); // 并发（越大越卡）

  // progress
  const [progress, setProgress] = useState({ stage: "", done: 0, total: 0, note: "" });

  // result
  const [result, setResult] = useState(null);

  async function safeJson(resp) {
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { ok: false, http_status: resp.status, raw };
    }
  }

  // ----------------------------
  // PPTX (browser) extract
  // ----------------------------
  function decodeBasicEntities(s) {
    return String(s || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function xmlTextToPlain(xml) {
    const texts = [];
    const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml))) {
      const s = decodeBasicEntities(m[1] || "");
      if (s.trim()) texts.push(s.trim());
    }
    return texts.join(" ");
  }

  async function extractPptxInBrowser(pptxFile) {
    const name = (pptxFile?.name || "").toLowerCase();
    if (!name.endsWith(".pptx")) return { ok: false, error: "仅支持 .pptx（请将 ppt 另存为 pptx）" };
    if (!zipReady || !window.JSZip) return { ok: false, error: "解析组件未就绪（JSZip 未加载）" };

    const JSZip = window.JSZip;
    const ab = await pptxFile.arrayBuffer();
    const zip = await JSZip.loadAsync(ab);

    const slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => {
        const na = Number((a.match(/slide(\d+)\.xml/) || [])[1] || 0);
        const nb = Number((b.match(/slide(\d+)\.xml/) || [])[1] || 0);
        return na - nb;
      });

    const pages = [];
    for (let i = 0; i < slidePaths.length; i++) {
      const p = slidePaths[i];
      const xml = await zip.file(p).async("string");
      const content = xmlTextToPlain(xml);
      pages.push({ page: i + 1, content });
    }

    // images (ppt/media/*)
    const mediaPaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/media\/.+\.(png|jpg|jpeg|webp)$/i.test(p))
      .sort();

    const images = [];
    for (const p of mediaPaths) {
      const blob = await zip.file(p).async("blob");
      images.push({ name: p.split("/").pop(), path: p, blob, size: blob.size });
    }

    return { ok: true, pages, images };
  }

  // get image dimensions in browser
  async function getImageSize(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const out = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
        URL.revokeObjectURL(url);
        resolve(out);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ w: 0, h: 0 });
      };
      img.src = url;
    });
  }

  // heuristic: likely contains text
  async function filterLikelyTextImages(images) {
    // 经验阈值：太小的图往往是 icon/背景；太小分辨率 OCR 价值低
    const MIN_BYTES = 40 * 1024; // 40KB
    const MIN_W = 600;
    const MIN_H = 350;

    const out = [];
    for (const it of images) {
      if (it.size < MIN_BYTES) continue;
      const { w, h } = await getImageSize(it.blob);
      if (w >= MIN_W && h >= MIN_H) out.push({ ...it, w, h });
    }
    return out;
  }

  // ----------------------------
  // OCR (browser) - batching
  // ----------------------------
  async function ocrOne(blob, logger) {
    if (!ocrReady || !window.Tesseract) throw new Error("OCR 组件未就绪（Tesseract 未加载）");
    const T = window.Tesseract;

    // 优先中文+英文；失败再降级英文，提升稳定性
    try {
      const r = await T.recognize(blob, "chi_sim+eng", {
        logger: logger || (() => {})
      });
      return String(r?.data?.text || "").trim();
    } catch {
      const r2 = await T.recognize(blob, "eng", {
        logger: logger || (() => {})
      });
      return String(r2?.data?.text || "").trim();
    }
  }

  async function runPool(items, concurrency, worker) {
    const results = new Array(items.length);
    let idx = 0;
    const runners = new Array(concurrency).fill(0).map(async () => {
      while (idx < items.length) {
        const cur = idx++;
        results[cur] = await worker(items[cur], cur);
      }
    });
    await Promise.all(runners);
    return results;
  }

  async function ocrImagesInBatches(images) {
    const total = images.length;
    const outTexts = [];

    let processed = 0;
    for (let start = 0; start < total; start += batchSize) {
      const batch = images.slice(start, start + batchSize);

      setProgress({
        stage: "图片识别",
        done: processed,
        total,
        note: `第 ${Math.floor(start / batchSize) + 1} 批 / 共 ${Math.ceil(total / batchSize)} 批`
      });

      const batchTexts = await runPool(batch, ocrConcurrency, async (img, i) => {
        const text = await ocrOne(img.blob);
        processed += 1;
        setProgress({
          stage: "图片识别",
          done: processed,
          total,
          note: `正在识别：${img.name || `img_${start + i + 1}`}`
        });
        return { name: img.name, text };
      });

      outTexts.push(...batchTexts);
    }

    setProgress({ stage: "图片识别", done: total, total, note: "完成" });
    return outTexts;
  }

  // ----------------------------
  // AI helpers
  // ----------------------------
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
        rules_issues_fix: aiReportRaw.rules_issues_fix,
        ai_extra: Array.isArray(aiReportRaw.ai_extra) ? aiReportRaw.ai_extra : []
      };
    }

    const legacy = aiReportRaw?.ai;
    if (Array.isArray(legacy)) {
      return {
        ok: true,
        final_summary: { overall: "", top_risks: [], next_actions: [] },
        rules_issues_fix: legacy.map((x) => ({
          rule_id: x.rule_id,
          page: x.page ?? null,
          quote: Array.isArray(x.quote) ? x.quote.slice(0, 3) : [],
          problem: x.problem || "",
          rewrite: Array.isArray(x.rewrite_suggestion)
            ? x.rewrite_suggestion.slice(0, 3).map((r) => ({
                action: r.action || "修改/补充",
                before: r.before || "",
                after: r.after || ""
              }))
            : [],
          note: x.notes || ""
        })),
        ai_extra: []
      };
    }

    return null;
  }

  // 前端再做一次去重：相同 rule_id + page + before + after 的，只留一条
  function dedupeFixes(fixes) {
    const seen = new Set();
    const out = [];
    for (const it of fixes || []) {
      const rw0 = Array.isArray(it?.rewrite) && it.rewrite[0] ? it.rewrite[0] : {};
      const key = `${it?.rule_id || ""}__${it?.page ?? ""}__${String(rw0.before || "").trim()}__${String(
        rw0.after || ""
      ).trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  // ----------------------------
  // Run
  // ----------------------------
  async function onRun() {
    if (!file) {
      alert("请先选择文件");
      return;
    }

    setLoading(true);
    setResult(null);
    setProgress({ stage: "准备", done: 0, total: 0, note: "" });

    try {
      const fname = (file?.name || "").toLowerCase();
      let extract;

      // 1) Extract
      if (fname.endsWith(".pptx")) {
        setProgress({ stage: "解析课件", done: 0, total: 1, note: "本地解析 PPTX（不上传文件）" });
        extract = await extractPptxInBrowser(file);
      } else {
        // docx/txt 继续走后端
        setProgress({ stage: "解析课件", done: 0, total: 1, note: "上传并提取文本" });
        const fd = new FormData();
        fd.append("file", file);
        const r1 = await fetch("/api/extract", { method: "POST", body: fd });
        extract = await safeJson(r1);
      }

      if (!extract.ok || !Array.isArray(extract.pages) || extract.pages.length === 0) {
        setResult({
          stage: "error",
          title: "处理失败",
          message: extract?.error || "提取失败：未获取到页面内容",
          detail: extract
        });
        return;
      }

      // 2) OCR images (optional, only for pptx)
      let ocrTexts = [];
      if (fname.endsWith(".pptx") && enableOcr) {
        let images = Array.isArray(extract.images) ? extract.images : [];

        // 限制最大图片数
        if (images.length > maxImages) images = images.slice(0, maxImages);

        // 只挑“高概率含字”
        if (onlyLikelyText) {
          setProgress({ stage: "筛选图片", done: 0, total: images.length, note: "筛选疑似含字图片" });
          images = await filterLikelyTextImages(images);
        }

        if (images.length > 0) {
          ocrTexts = await ocrImagesInBatches(images);
        }
      }

      // 组装 pages（把 OCR 文本合并到末尾页）
      const pages = [...extract.pages];
      if (ocrTexts.length > 0) {
        const joined = ocrTexts
          .map((x) => (x?.text ? `【${x.name || "图片"}】\n${x.text}` : ""))
          .filter(Boolean)
          .join("\n\n");

        if (joined.trim()) {
          pages.push({
            page: pages.length + 1,
            content: `【图片识别内容】\n${joined}`.slice(0, 50000) // 防止过大
          });
        }
      }

      // 3) Rules Audit
      setProgress({ stage: "规则审核", done: 0, total: 1, note: "按 rules/rules.json 检测" });
      const r2 = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages })
      });
      const audit = await safeJson(r2);

      if (!audit || typeof audit !== "object") {
        setResult({ stage: "error", title: "处理失败", message: "规则审核失败：返回异常", detail: audit });
        return;
      }

      // 4) AI report
      setProgress({ stage: "AI 复核", done: 0, total: 1, note: "生成融合报告与整改建议" });

      const pagesText = pages.map((p) => `【第${p.page}页】\n${p.content || ""}`).join("\n\n");

      // 取 rulesJson
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

      const r3 = await fetch("/api/ai_review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "report",
          pagesText,
          audit,
          rulesJson
        })
      });

      const aiReportRaw = await safeJson(r3);
      const aiReport = normalizeAiReport(aiReportRaw);
      const aiUsed = isAiReportEffective(aiReportRaw);

      const fixes = aiUsed && Array.isArray(aiReport?.rules_issues_fix) ? dedupeFixes(aiReport.rules_issues_fix) : [];

      setProgress({ stage: "完成", done: 1, total: 1, note: "" });
      setResult({
        stage: "done",
        audit,
        aiReport,
        aiUsed,
        rulesOk,
        aiHttpStatus: r3.status,
        aiRaw: aiReportRaw,
        fixes,
        meta: {
          pages: pages.length,
          ocrAdded: ocrTexts.length > 0,
          ocrCount: ocrTexts.length
        }
      });
    } catch (e) {
      setResult({ stage: "error", title: "处理失败", message: "客户端异常", detail: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  // ----------------------------
  // UI computed
  // ----------------------------
  const auditPass = result?.audit?.pass === true;
  const riskLevel = result?.audit?.risk_level || "unknown";
  const ai = result?.aiReport;
  const fixesToShow = Array.isArray(result?.fixes) ? result.fixes : [];

  const statusChip = useMemo(() => {
    if (!result) return { text: "待开始", tone: "muted" };
    if (result.stage === "error") return { text: "失败", tone: "bad" };
    if (result.stage === "done") {
      if (auditPass) return { text: "通过", tone: "good" };
      return { text: "需整改", tone: riskLevel === "high" ? "bad" : "warn" };
    }
    return { text: "处理中", tone: "warn" };
  }, [result, auditPass, riskLevel]);

  function toneStyle(tone) {
    if (tone === "good") return { background: "#ecfdf3", border: "1px solid #a7f3d0", color: "#065f46" };
    if (tone === "warn") return { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" };
    if (tone === "bad") return { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" };
    return { background: "#f8fafc", border: "1px solid #e5e7eb", color: "#334155" };
  }

  const canRun = !!file && !loading;

  return (
    <div style={{ minHeight: "100vh", background: "#f6f7fb" }}>
      {/* CDN libs (no npm install) */}
      <Script
        src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
        strategy="afterInteractive"
        onLoad={() => setZipReady(true)}
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"
        strategy="afterInteractive"
        onLoad={() => setOcrReady(true)}
      />

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "22px 16px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.2 }}>课件审核</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
              上传后自动完成：文本提取 → 规则检测 → AI 复核（可选：图片文字识别）
            </div>
          </div>

          <div
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 700,
              ...toneStyle(statusChip.tone)
            }}
          >
            {statusChip.text}
          </div>
        </div>

        {/* Card: Upload */}
        <div
          style={{
            marginTop: 14,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 14,
            padding: 14,
            boxShadow: "0 6px 18px rgba(15, 23, 42, 0.06)"
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ flex: "1 1 420px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: "#0f172a" }}>选择文件</div>
              <input
                type="file"
                accept=".pptx,.docx,.txt"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid #e5e7eb",
                  background: "#f8fafc"
                }}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
                支持：PPTX / DOCX / TXT（PPTX 会在浏览器本地解析，避免上传过大失败）
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                onClick={onRun}
                disabled={!canRun}
                style={{
                  padding: "10px 14px",
                  borderRadius: 12,
                  border: "1px solid #1f2937",
                  background: canRun ? "#111827" : "#9ca3af",
                  color: "#fff",
                  fontWeight: 800,
                  cursor: canRun ? "pointer" : "not-allowed",
                  minWidth: 120
                }}
              >
                {loading ? "处理中…" : "开始审核"}
              </button>
            </div>
          </div>

          {/* Options */}
          <div
            style={{
              marginTop: 12,
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
              paddingTop: 12,
              borderTop: "1px dashed #e5e7eb"
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#0f172a" }}>
              <input
                type="checkbox"
                checked={enableOcr}
                onChange={(e) => setEnableOcr(e.target.checked)}
                disabled={!ocrReady}
              />
              识别图片文字（OCR）
              <span style={{ color: "#64748b" }}>
                {!ocrReady ? "（OCR 组件加载中）" : ""}
              </span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#0f172a" }}>
              <input
                type="checkbox"
                checked={onlyLikelyText}
                onChange={(e) => setOnlyLikelyText(e.target.checked)}
                disabled={!enableOcr}
              />
              只识别疑似含字图片
            </label>

            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#0f172a" }}>
              每批
              <select
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                disabled={!enableOcr}
                style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff" }}
              >
                <option value={15}>15</option>
                <option value={30}>30</option>
                <option value={50}>50</option>
              </select>
              张
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#0f172a" }}>
              最多识别
              <input
                value={maxImages}
                onChange={(e) => setMaxImages(Math.max(0, Number(e.target.value || 0)))}
                disabled={!enableOcr}
                style={{
                  width: 76,
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: "1px solid #e5e7eb",
                  background: "#fff"
                }}
              />
              张
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#0f172a" }}>
              并发
              <select
                value={ocrConcurrency}
                onChange={(e) => setOcrConcurrency(Number(e.target.value))}
                disabled={!enableOcr}
                style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff" }}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </div>

            <div style={{ marginLeft: "auto", fontSize: 12, color: "#64748b" }}>
              组件：{zipReady ? "PPTX 解析就绪" : "PPTX 解析加载中"} / {ocrReady ? "OCR 就绪" : "OCR 加载中"}
            </div>
          </div>

          {/* Progress */}
          {loading && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#334155" }}>
                <div style={{ fontWeight: 700 }}>{progress.stage || "处理中"}</div>
                <div style={{ color: "#64748b" }}>{progress.note || ""}</div>
              </div>
              <div style={{ height: 10, background: "#eef2ff", borderRadius: 999, marginTop: 8, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width:
                      progress.total > 0 ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` : "35%",
                    background: "#4f46e5"
                  }}
                />
              </div>
              {progress.total > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: "#64748b" }}>
                  {progress.done} / {progress.total}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Result */}
        <div style={{ marginTop: 14 }}>
          {!result && (
            <div style={{ fontSize: 13, color: "#64748b", padding: "10px 2px" }}>
              选择文件后点击“开始审核”。
            </div>
          )}

          {result?.stage === "error" && (
            <div
              style={{
                background: "#fff",
                border: "1px solid #fecaca",
                borderRadius: 14,
                padding: 14,
                boxShadow: "0 6px 18px rgba(15, 23, 42, 0.06)"
              }}
            >
              <div style={{ fontWeight: 800, color: "#991b1b" }}>{result.title || "失败"}</div>
              <div style={{ marginTop: 8, whiteSpace: "pre-wrap", color: "#334155", fontSize: 13 }}>
                {result.message || "（无）"}
              </div>

              {/* 少量可读信息，避免技术堆字 */}
              {result?.detail?.http_status ? (
                <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
                  状态码：{result.detail.http_status}
                </div>
              ) : null}
            </div>
          )}

          {result?.stage === "done" && (
            <>
              {/* Summary Card */}
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 14,
                  padding: 14,
                  boxShadow: "0 6px 18px rgba(15, 23, 42, 0.06)"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 900, color: "#0f172a" }}>
                      {auditPass ? "审核通过" : "发现问题（需整改）"}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
                      风险等级：{riskLevel} · 页数：{result?.meta?.pages || "-"}
                      {result?.meta?.ocrAdded ? ` · OCR已追加（${result.meta.ocrCount} 张图片）` : ""}
                    </div>
                  </div>

                  <div
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 800,
                      ...toneStyle(auditPass ? "good" : riskLevel === "high" ? "bad" : "warn")
                    }}
                  >
                    {auditPass ? "通过" : "需整改"}
                  </div>
                </div>

                <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>
                  AI：{result.aiUsed ? "已生成整改建议" : "未生成（请检查 /api/ai_review）"} · 规则库：{result.rulesOk ? "正常" : "异常"}
                </div>

                {!result.aiUsed && result.aiRaw && (
                  <div
                    style={{
                      marginTop: 10,
                      background: "#f8fafc",
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      padding: 10,
                      fontSize: 12,
                      color: "#334155"
                    }}
                  >
                    {result.aiRaw.error || result.aiRaw.detail || "AI 未返回可用结果"}
                  </div>
                )}
              </div>

              {/* AI report */}
              {result.aiUsed && ai?.final_summary && (
                <div
                  style={{
                    marginTop: 12,
                    background: "#fff",
                    border: "1px solid #e5e7eb",
                    borderRadius: 14,
                    padding: 14,
                    boxShadow: "0 6px 18px rgba(15, 23, 42, 0.06)"
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 900, color: "#0f172a" }}>融合报告</div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, color: "#64748b" }}>总体结论</div>
                    <div style={{ marginTop: 6, whiteSpace: "pre-wrap", fontSize: 13, color: "#0f172a" }}>
                      {ai.final_summary.overall || "（无）"}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
                    <div style={{ flex: "1 1 280px" }}>
                      <div style={{ fontSize: 12, color: "#64748b" }}>关键风险</div>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13, color: "#0f172a" }}>
                        {(ai.final_summary.top_risks || []).slice(0, 3).map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                        {(!ai.final_summary.top_risks || ai.final_summary.top_risks.length === 0) && <li>（无）</li>}
                      </ul>
                    </div>
                    <div style={{ flex: "1 1 280px" }}>
                      <div style={{ fontSize: 12, color: "#64748b" }}>下一步建议</div>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13, color: "#0f172a" }}>
                        {(ai.final_summary.next_actions || []).slice(0, 3).map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                        {(!ai.final_summary.next_actions || ai.final_summary.next_actions.length === 0) && <li>（无）</li>}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Fix list */}
              <div
                style={{
                  marginTop: 12,
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 14,
                  padding: 14,
                  boxShadow: "0 6px 18px rgba(15, 23, 42, 0.06)"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 900, color: "#0f172a" }}>整改建议</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {fixesToShow.length > 0 ? `${fixesToShow.length} 条` : "（无）"}
                  </div>
                </div>

                {result.aiUsed ? (
                  fixesToShow.length > 0 ? (
                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                      {fixesToShow.map((it, idx) => {
                        const rw = Array.isArray(it.rewrite) ? it.rewrite : [];
                        const rw0 = rw[0] || {};
                        return (
                          <div
                            key={idx}
                            style={{
                              border: "1px solid #e5e7eb",
                              borderRadius: 12,
                              padding: 12,
                              background: "#ffffff"
                            }}
                          >
                            <div style={{ fontSize: 12, color: "#64748b" }}>
                              #{idx + 1} · rule_id {it.rule_id} · 第 {it.page ?? "-"} 页
                            </div>

                            {Array.isArray(it.quote) && it.quote.length > 0 && (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontSize: 12, color: "#64748b" }}>原文</div>
                                <div style={{ marginTop: 6, whiteSpace: "pre-wrap", fontSize: 13, color: "#0f172a" }}>
                                  {it.quote.slice(0, 1).join("\n")}
                                </div>
                              </div>
                            )}

                            {it.problem ? (
                              <div style={{ marginTop: 10 }}>
                                <div style={{ fontSize: 12, color: "#64748b" }}>问题</div>
                                <div style={{ marginTop: 6, whiteSpace: "pre-wrap", fontSize: 13, color: "#0f172a" }}>
                                  {it.problem}
                                </div>
                              </div>
                            ) : null}

                            <div style={{ marginTop: 10 }}>
                              <div style={{ fontSize: 12, color: "#64748b" }}>建议</div>
                              <div
                                style={{
                                  marginTop: 8,
                                  background: "#f8fafc",
                                  border: "1px solid #e5e7eb",
                                  borderRadius: 12,
                                  padding: 10
                                }}
                              >
                                <div style={{ fontSize: 12, color: "#64748b" }}>替换为</div>
                                <div style={{ marginTop: 6, whiteSpace: "pre-wrap", fontSize: 13, color: "#0f172a", fontWeight: 700 }}>
                                  {String(rw0.after || "（无）")}
                                </div>
                              </div>
                            </div>

                            {it.note ? (
                              <div style={{ marginTop: 10, fontSize: 12, color: "#64748b", whiteSpace: "pre-wrap" }}>
                                {it.note}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, fontSize: 13, color: "#64748b" }}>AI 未返回可用整改建议。</div>
                  )
                ) : (
                  <div style={{ marginTop: 12, fontSize: 13, color: "#64748b" }}>
                    AI 未生成整改建议（请检查后端 /api/ai_review）。
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

  );
}
