export const runtime = "nodejs";

export async function POST(req) {
  // 先验证：POST 是否能被命中
  // 前端会收到 ok:true
  return new Response(JSON.stringify({ ok: true, msg: "extract route works (app router)" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  return new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
