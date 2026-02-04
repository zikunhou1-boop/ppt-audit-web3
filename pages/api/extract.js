export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }
    // 先返回一个固定 JSON，验证接口通了
    return res.status(200).json({ ok: true, pages_count: 1, pages: [{ page: 1, content: "extract ok" }] });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e), stack: e?.stack });
  }
}

    const f = files?.file;
    if (!f) return res.status(400).json({ ok: false, error: "file is required" });

    const filepath = f.filepath || f.path;
    const original = f.originalFilename || f.name || "";
    const ext = path.extname(original).toLowerCase();

    const buffer = fs.readFileSync(filepath);

    let out;
    if (ext === ".pptx") {
      out = await parsePptx(buffer);
    } else if (ext === ".ppt") {
      out = { ok: false, error: "暂不支持 .ppt（老格式），请另存为 .pptx" };
    } else if (ext === ".docx") {
      out = await parseDocxPlaceholder(buffer);
    } else if (ext === ".txt") {
      out = await parseTxt(buffer);
    } else {
      out = { ok: false, error: `不支持的文件类型：${ext || "未知"}` };
    }

    // 永远返回 JSON
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e),
      stack: e?.stack
    });
  }
}
