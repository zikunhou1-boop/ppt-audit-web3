// pages/index.js
import { useEffect, useMemo, useState } from "react";
import Script from "next/script";

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  // OCR 开关 & 进度
  const [enableOcr, setEnableOcr] = useState(true);
  const [ocrStatus, setOcrStatus] = useState({ stage: "idle", done: 0, total: 0, msg: "" });

  // 三方库是否就绪（CDN 注入）
  const [libsReady, setLibsReady] = useState(false);

  // 最终结果：extract + audit + aiReport + ocrText
  const [result, setResult] = useState(null);

  async function safeJson(resp) {
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      return { ok: false, http_status: resp.status, raw };
    }
  }

  // 判定“AI 是否生效”：后端 ok:true 且 rules_issues_fix 非空
  function isAiReportEffective(aiReportRaw) {
    if (!aiReportRaw || typeof aiReportRaw !== "object") return false;
    if (aiReportRaw.ok !== true) return false;
    if (!Array.isArray(aiReportRaw.rules_issues_fix) || aiReportRaw.rules_issues_fix.length === 0) return false;
    return true;
  }

  // 规范化成 report 结构（只做展示转换）
  function normalizeAiReport(aiReportRaw) {
    if (!aiReportRaw || typeof aiReportRaw !== "object") return null;

    // report 结构
    if (aiReportRaw?.final_summary && Array.isArray(aiReportRaw?.rules_issues_fix)) {
      return {
        ok: aiReportRaw.ok === true,
        final_summary: aiReportRaw.final_summary,
        rules_issues_fix: aiReportRaw.rules_issues_fix,
        ai_extra: Array.isArray(aiReportRaw.ai_extra) ? aiReportRaw.ai_extra : []
      };
    }

    // legacy：{ ai: [...] } -> report
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

  // --- OCR：浏览器端解包 PPTX 的 ppt/media/* 图片，逐张 OCR ---
  async function ocrPptxImages(pptxFile, opts = {}) {
    const { maxConcurrency = 2 } = opts;

    // 只支持 pptx（ppt 不是 zip）
    const name = (pptxFile?.name || "").toLowerCase();
    if (!name.endsWith(".pptx")) {
      return { ok: false, text: "", error: "仅支持 PPTX 图片 OCR（.ppt 不是 zip，无法直接解包）。请另存为 .pptx 再试。" };
    }

    if (!libsReady || typeof window === "undefined") {
      return { ok: false, text: "", error: "OCR 依赖库未加载完成（JSZip/Tesseract）。请稍等 1-2 秒再点审核。" };
    }

    const JSZip = window.JSZip;
    const Tesseract = window.Tesseract;
    if (!JSZip || !Tesseract) {
      return { ok: false, text: "", error: "OCR 依赖库缺失（JSZip/Tesseract 未注入）。" };
    }

    setOcrStatus({ stage: "loading_zip", done: 0, total: 0, msg: "解包 PPTX 中..." });

    const ab = await pptxFile.arrayBuffer();
    const zip = await JSZip.loadAsync(ab);

    const mediaFiles = Object.keys(zip.files)
      .filter((p) => /^ppt\/media\//.test(p))
      .filter((p) => /\.(png|jpg|jpeg|webp)$/i.test(p))
      .sort();

    const total = mediaFiles.length;
    setOcrStatus({ stage: "found_images", done: 0, total, msg: total ? `发现 ${total} 张图片，开始 OCR...` : "未发现图片" });

    if (total === 0) return { ok: true, text: "", images: 0 };

    // 简单并发池
    let idx = 0;
    let done = 0;
    const outputs = [];

    async function worker(workerId) {
      while (idx < mediaFiles.length) {
        const myIdx = idx++;
        const path = mediaFiles[myIdx];

        try {
          const blob = await zip.file(path).async("blob");

          // 识别：中英混合
          const r = await Tesseract.recognize(blob, "chi_sim+eng", {
            logger: () => {}
          });

          const text = (r?.data?.text || "").trim();
          if (text) {
            outputs.push(`【图片OCR：${path.replace("ppt/media/", "")}】\n${text}`);
          }
        } catch (e) {
          // 单张失败不影响整体
          outputs.push(`【图片OCR：${path.replace("ppt/media/", "")}】\n（OCR失败：${String(e?.message || e)}）`);
        } finally {
          done++;
          setOcrStatus({
            stage: "ocring",
            done,
            total,
            msg: `OCR 进行中：${done}/${total}`
          });
        }
      }
    }

    const workers = [];
    const cc = Math.max(1, Math.min(maxConcurrency, 4)); // 保护：最多 4 并发，避免浏览器卡死
    for (let i = 0; i < cc; i++) workers.push(worker(i));
    await Promise.all(workers);

    setOcrStatus({ stage: "done", done: total, total, msg: "OCR 完成" });

    // 把所有图片 OCR 拼成一个大段
    const merged = outputs.join("\n\n");
    return { ok: true, text: merged, images: total };
  }

  // --- （可选）AI 侧去重：把 audit.issues 的重复项在送 AI 前合并，减少重复输出 ---
  function dedupeIssuesForAi(audit) {
    const issues = Array.isArray(audit?.issues) ? audit.issues : [];
    const map = new Map();

    for (const it of issues) {
      const key = `${it.rule_id || ""}__${it.page ?? ""}__${it.type || ""}__${it.hit || ""}__${it.message || ""}`;
      if (!map.has(key)) map.set(key, it);
    }

    const deduped = Array.from(map.values());

    // 返回一个“浅拷贝”的 audit，保证不影响你原 audit 展示
    return { ...audit, issues: deduped };
  }

  async function onRun() {
    if (!file) {
      alert("请先选择文件（ppt/pptx/docx/txt）");
      return;
    }
    setLoading(true);
    setResult(null);
    setOcrStatus({ stage: "idle", done: 0, total: 0, msg: "" });

    try {
      // 1) Extract（仍用你后端 extract 提取文字）
      const fd = new FormData();
      fd.append("file", file);

      const r1 = await fetch("/api/extract", { method: "POST", body: fd });
      const extract = await safeJson(r1);

      if (!extract.ok || !Array.isArray(extract.pages) || extract.pages.length === 0) {
        setResult({ stage: "error", message: "提取失败：未获取到页面内容", detail: extract });
        return;
      }

      // 2) Rules Audit（rules.json 检测）
      const r2 = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: extract.pages })
      });
      const audit = await safeJson(r2);

      if (!audit || typeof audit !== "object") {
        setResult({ stage: "error", message: "规则审核失败：返回异常", detail: audit });
        return;
      }

      // 2.5) 可选：给 AI 的 issues 去重，减少重复整改项
      const auditForAi = dedupeIssuesForAi(audit);

      // 3) 浏览器 OCR（仅 PPTX）
      let ocrText = "";
      let ocrMeta = null;
      if (enableOcr) {
        const ocr = await ocrPptxImages(file, { maxConcurrency: 2 });
        ocrMeta = ocr;
        if (ocr.ok && ocr.text) ocrText = ocr.text;
      }

      // 4) AI Review（report 模式）
      const pagesText = (extract.pages || [])
        .map((p) => `【第${p.page || ""}页】\n${p.content || ""}`)
        .join("\n\n");

      // 把 OCR 文本拼到全文后面给 AI（规则仍以 audit 为准）
      const pagesTextWithOcr = ocrText
        ? `${pagesText}\n\n====================\n【图片OCR补充内容】\n${ocrText}\n`
        : pagesText;

      // 从后端接口取 rulesJson（你现在的 /api/rules 会读 rules/rules.json）
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
          pagesText: pagesTextWithOcr,
          audit: auditForAi,
          rulesJson
        })
      });

      const aiReportRaw = await safeJson(r3);
      const aiReport = normalizeAiReport(aiReportRaw);
      const aiUsed = isAiReportEffective(aiReportRaw);

      setResult({
        stage: "done",
        extract,
        audit, // 原 audit 用于页面展示（不去重）
        auditForAi, // 给 AI 的 audit（去重后）
        aiReport,
        aiUsed,
        rulesOk,
        aiHttpStatus: r3.status,
        aiRaw: aiReportRaw,
        ocrMeta,
        ocrTextPreview: ocrText ? ocrText.slice(0, 800) : ""
      });
    } catch (e) {
      setResult({ stage: "error", message: "客户端异常", detail: String(e?.message || e) });
    } finally {
      setLoading(false);
    }
  }

  const auditPass = result?.audit?.pass === true;
  const riskLevel = result?.audit?.risk_level || "unknown";
  const ai = result?.aiReport;

  const fixesToShow = result?.aiUsed && Array.isArray(ai?.rules_issues_fix) ? ai.rules_issues_fix : [];

  const ocrTip = useMemo(() => {
    if (!enableOcr) return "OCR：关闭（只用提取文本 + 规则 + AI）";
    if (!libsReady) return "OCR：依赖库加载中（JSZip/Tesseract）...";
    if (ocrStatus.stage === "idle") return "OCR：开启（PPTX 图片将尝试识别）";
    return `OCR：${ocrStatus.msg || ""}`;
  }, [enableOcr, libsReady, ocrStatus]);

  useEffect(() => {
    // CDN 脚本加载后会触发 onLoad 设置 libsReady
  }, []);

  return (
    <div style={{ maxWidth: 980, margin: "28px auto", padding: 16, fontFamily: "system-ui, -apple-system" }}>
      {/* CDN：不用 npm 安装，Vercel 和局域网都能跑 */}
      <Script
        src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
        strategy="beforeInteractive"
        onLoad={() => {
          // 两个都加载完才 ready（下面 Tesseract 的 onLoad 也会 set）
          setTimeout(() => {
            if (window.JSZip && window.Tesseract) setLibsReady(true);
          }, 0);
        }}
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"
        strategy="beforeInteractive"
        onLoad={() => {
          setTimeout(() => {
            if (window.JSZip && window.Tesseract) setLibsReady(true);
          }, 0);
        }}
      />

      <h2>课件合规初审（规则 + AI + 图片OCR）</h2>

      <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="file"
            accept=".ppt,.pptx,.docx,.txt"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#444" }}>
            <input
              type="checkbox"
              checked={enableOcr}
              onChange={(e) => setEnableOcr(e.target.checked)}
            />
            启用 PPTX 图片 OCR（免费，浏览器本地识别）
          </label>
        </div>

        <div style={{ marginTop: 8, fontSize: 13, color: "#666" }}>{ocrTip}</div>

        <div style={{ marginTop: 10 }}>
          <button onClick={onRun} disabled={loading} style={{ padding: "8px 14px" }}>
            {loading ? "审核中..." : "一键审核（提取 → 规则 → OCR → AI融合报告）"}
          </button>
        </div>

        <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
          支持：pptx/docx/txt（图片OCR仅 pptx；ppt 请另存为 pptx）
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3>结果</h3>

        {!result && <div style={{ color: "#666" }}>上传文件后点击“一键审核”。</div>}

        {result && result.stage === "error" && (
          <div style={{ border: "1px solid #f0d7d7", background: "#fff5f5", borderRadius: 10, padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>失败</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{result.message || "（无）"}</div>
            {result.detail ? (
              <pre style={{ marginTop: 8, whiteSpace: "pre-wrap", background: "#fafafa", padding: 10, borderRadius: 8 }}>
                {JSON.stringify(result.detail, null, 2)}
              </pre>
            ) : null}
          </div>
        )}

        {result && result.stage === "done" && (
          <>
            <div style={{ marginBottom: 10, fontWeight: 700 }}>
              规则审核：{auditPass ? "通过" : "不通过"}（risk_level：{riskLevel}）
            </div>

            <div style={{ marginBottom: 10, color: "#666", fontSize: 13 }}>
              AI 融合复核：{result.aiUsed ? "已生效（AI 输出）" : `未生效（接口返回 ${result.aiHttpStatus}）`}
              {" · "}
              规则库读取：{result.rulesOk ? "正常" : "异常（/api/rules 可能没返回 rulesJson）"}
              {" · "}
              OCR：{enableOcr ? (result.ocrMeta?.ok ? `已尝试（图片 ${result.ocrMeta.images || 0} 张）` : `失败/跳过`) : "关闭"}
            </div>

            {/* OCR 失败原因（可读） */}
            {enableOcr && result.ocrMeta && result.ocrMeta.ok === false && (
              <div style={{ border: "1px solid #eee", background: "#fafafa", borderRadius: 10, padding: 10, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>OCR 未生效原因</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "#444" }}>{result.ocrMeta.error || "（无）"}</div>
              </div>
            )}

            {/* AI 未生效原因 */}
            {!result.aiUsed && result.aiRaw && (
              <div style={{ border: "1px solid #eee", background: "#fafafa", borderRadius: 10, padding: 10, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>AI 未生效原因（/api/ai_review 返回）</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "#444" }}>
                  {result.aiRaw.error || result.aiRaw.detail || "（无 error/detail 字段）"}
                </div>
                {result.aiRaw.http_status ? (
                  <div style={{ marginTop: 6, fontSize: 13, color: "#666" }}>DeepSeek http_status：{result.aiRaw.http_status}</div>
                ) : null}
              </div>
            )}

            {/* 融合报告 */}
            {result.aiUsed && ai?.final_summary ? (
              <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>融合报告（AI 在规则基础上 + OCR补充内容 做复核）</div>

                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>总体结论</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{ai.final_summary.overall || "（无）"}</div>
                </div>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 260px" }}>
                    <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>关键风险（最多3条）</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(ai.final_summary.top_risks || []).slice(0, 3).map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                      {(!ai.final_summary.top_risks || ai.final_summary.top_risks.length === 0) && <li>（无）</li>}
                    </ul>
                  </div>

                  <div style={{ flex: "1 1 260px" }}>
                    <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>下一步建议（最多3条）</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {(ai.final_summary.next_actions || []).slice(0, 3).map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                      {(!ai.final_summary.next_actions || ai.final_summary.next_actions.length === 0) && <li>（无）</li>}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            <h4>可落地整改清单（按规则命中项逐条给改写）</h4>

            {fixesToShow.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {fixesToShow.map((it, idx) => (
                  <div key={idx} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>
                      #{idx + 1}｜rule_id：{it.rule_id}｜页：{it.page}
                    </div>

                    {Array.isArray(it.quote) && it.quote.length > 0 && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>定位原文（quote）</div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {it.quote.slice(0, 3).map((q, i) => (
                            <li key={i} style={{ whiteSpace: "pre-wrap" }}>
                              {q}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {it.problem && (
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>问题说明</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{it.problem}</div>
                      </div>
                    )}

                    <div>
                      <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>改写建议（before → after）</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(it.rewrite || []).slice(0, 3).map((rw, i) => (
                          <div key={i} style={{ background: "#f7f7f7", borderRadius: 8, padding: 10 }}>
                            <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>
                              动作：{rw.action || "（无）"}
                            </div>
                            <div style={{ fontSize: 13, color: "#666" }}>before：</div>
                            <div style={{ whiteSpace: "pre-wrap", marginBottom: 6 }}>{rw.before || "（无）"}</div>
                            <div style={{ fontSize: 13, color: "#666" }}>after：</div>
                            <div style={{ whiteSpace: "pre-wrap", fontWeight: 600 }}>{rw.after || "（无）"}</div>
                          </div>
                        ))}
                        {(!it.rewrite || it.rewrite.length === 0) && (
                          <div style={{ background: "#f7f7f7", borderRadius: 8, padding: 10, color: "#666" }}>
                            （AI 未返回改写建议）
                          </div>
                        )}
                      </div>
                    </div>

                    {it.note && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ color: "#666", fontSize: 13, marginBottom: 4 }}>备注</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{it.note}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "#666" }}>
                {result.aiUsed ? "（AI 未返回可用整改清单）" : "（AI 未生效：请先看上方原因并修后端）"}
              </div>
            )}

            <h4 style={{ marginTop: 14 }}>AI 额外发现（规则未覆盖/漏检的语义风险）</h4>
            {result.aiUsed && Array.isArray(ai?.ai_extra) && ai.ai_extra.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {ai.ai_extra.slice(0, 10).map((x, i) => (
                  <li key={i} style={{ whiteSpace: "pre-wrap" }}>
                    {typeof x === "string" ? x : JSON.stringify(x)}
                  </li>
                ))}
              </ul>
            ) : (
              <div style={{ color: "#666" }}>（无）</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
