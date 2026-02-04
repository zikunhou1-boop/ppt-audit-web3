import formidable from "formidable";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";

export const config = { api: { bodyParser: false } };

function decodeXmlText(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x0?A;/g, "\n");
}

async function parsePptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number((a.match(/slide(\d+)\.xml/) || [])[1] || 0);
      const nb = Number((b.match(/slide(\d+)\.xml/) || [])[1] || 0);
      return na - nb;
    });

  const pages = [];
  let pageNo = 1;

  for (const sf of slideFiles) {
    const xml = await zip.file(sf).async("string");
    const texts = [];
    const re = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml))) {
      const t = decodeXmlText(m[1]);
      if (t) texts.push(t);
    }
    const content = texts.join("\n").trim();
    pages.push({ page: pageNo++, content: content || "" });
  }

  const nonEmpty = pages.filter((p) => (p.content || "").trim().length > 0);
  return { ok: true, pages_count: nonEmpty.length, pages: nonEmpty };
}

async function parseDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = (result.value || "").trim();

  const chunkSize = 1500;
  const pages = [];
  let i = 0;
  let page = 1;
  while (i < text.length) {
    pages.push({ page, content: text.slice(i, i + chunkSize) });
    i += chunkSize;
    page += 1;
  }
  return { ok: true, pages_count: pages.length, pages };
}

function parseForm(req) {
  const form = formidable({
    multiples: true, // 关键：允许数组，兼容更多情况
    maxFileSize: 25 * 1024 * 1024,
    keepExtensions: true,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

// 关键：兼容 files.file / files["upload"] / 数组等各种形态
function pickFirstFile(files) {
  if (!files || typeof files !== "object") return null;

  const keys = Object.keys(files);
  for (const k of keys) {
    const v = files[k];
    if (!v) continue;
    if (Array.isArray(v) && v.length > 0) return v[0];
    if (typeof v === "object") return v;
  }
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const { files } = await parseForm(req);
    const f = pickFirstFile(files);

    if (!f) {
      return res.status(400).json({
        ok: false,
        error: "file is required (no file parsed by formidable)",
        debug_file_keys: files ? Object.keys(files) : [],
      });
    }

    const filepath = f.filepath || f.path; // formidable v3 uses filepath
    if (!filepath) {
      return res.status(400).json({
        ok: false,
        error: "failed to get uploaded file path",
        debug_file: {
          originalFilename: f.originalFilename,
          mimetype: f.mimetype,
          size: f.size,
          hasFilepath: Boolean(f.filepath),
          hasPath: Boolean(f.path),
        },
      });
    }

    const original = f.originalFilename || f.name || "upload";
    const ext = path.extname(original).toLowerCase();
    const buffer = fs.readFileSync(filepath);

    let out;
    if (ext === ".pptx") out = await parsePptx(buffer);
    else if (ext === ".ppt") out = { ok: false, error: "暂不支持 .ppt（老格式），请另存为 .pptx" };
    else if (ext === ".docx") out = await parseDocx(buffer);
    else if (ext === ".txt")
      out = { ok: true, pages_count: 1, pages: [{ page: 1, content: buffer.toString("utf-8") }] };
    else out = { ok: false, error: `不支持的文件类型：${ext || "未知"}` };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e),
      stack: e && e.stack ? String(e.stack) : "",
    });
  }
}
