import formidable from "formidable";
import fs from "fs";
import path from "path";
import JSZip from "jszip";

export const config = {
  api: { bodyParser: false }
};

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

function stripTags(xml) {
  return xml
    .replace(/<a:br\/?>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function parsePptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  // slide xml: ppt/slides/slide1.xml ...
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
    // pptx 文本一般在 <a:t>...</a:t>
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

  // 过滤全空页（有些 slide 没文字）
  const nonEmpty = pages.filter((p) => (p.content || "").trim().length > 0);

  return {
    ok: true,
    pages_count: nonEmpty.length,
    pages: nonEmpty
  };
}

async function parseTxt(buffer) {
  const text = buffer.toString("utf-8");
  const lines = text.split(/\r?\n/);
  // 按“约 1200 字”切成页，方便跑规则
  const chunkSize = 1200;
  const joined = lines.join("\n");
  const pages = [];
  let i = 0;
  let page = 1;
  while (i < joined.length) {
    pages.push({ page, content: joined.slice(i, i + chunkSize) });
    i += chunkSize;
    page += 1;
  }
  return { ok: true, pages_count: pages.length, pages };
}

async function parseDocxPlaceholder(buffer) {
  // 说明：docx 提取如果你项目里已经有 mammoth，就可直接接入；
  // 为避免 Vercel 运行时再崩，这里先做一个“安全占位”：把 docx 当 zip 抽取 document.xml 文本
  const zip = await JSZip.loadAsync(buffer);
  const docXml = zip.file("word/document.xml");
  if (!docXml) return { ok: false, error: "Invalid docx: missing word/document.xml" };
  const xml = await docXml.async("string");

  const rawText = stripTags(decodeXmlText(xml));
  const pages = [{ page: 1, content: rawText }];
  return { ok: true, pages_count: 1, pages };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const form = formidable({
      multiples: false,
      maxFileSize: 25 * 1024 * 1024 // 25MB
    });

    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

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
