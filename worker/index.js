/**
 * 오늘의 마음 💌 — 우체국 (Cloudflare Worker)
 *
 * 서버는 "암호문 봉투"만 맡아둔다. PIN은 절대 서버로 오지 않고,
 * 복호화는 전부 브라우저에서 일어나므로 우체국장(서버 운영자)도 내용을 못 본다.
 *
 * POST /letter                 {ct, deliverAt?, burn?}  → {id}
 * GET  /letter/:id                                      → {ct,burn} | {pending,deliverAt} | {gone}
 * POST /letter/:id/open        {burn?}                  → {ok}          (개봉 도장 + 소각)
 * GET  /letter/:id/status                               → {openedAt,gone,deliverAt}
 * POST /presence/:pair         {me}                     → {ok}
 * GET  /presence/:pair?me=...                           → {partner:bool}
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

const LETTER_TTL = 60 * 60 * 24 * 180; // 편지는 180일 뒤 자동 소멸
const PRESENCE_TTL = 60;               // 촛불은 60초
const MAX_CT = 512 * 1024;             // 봉투 한 통 최대 512KB

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const ID_RE = /^[\w-]{6,40}$/;

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") {
      return json({ post_office: "오늘의 마음 💌", ok: true });
    }

    try {
      /* ---------- 편지 부치기 ---------- */
      if (req.method === "POST" && path === "/letter") {
        const body = await req.json();
        const ct = body && body.ct;
        if (typeof ct !== "string" || !ct.length || ct.length > MAX_CT) {
          return json({ error: "bad_envelope" }, 400);
        }
        let deliverAt = null;
        if (body.deliverAt) {
          const t = Number(body.deliverAt);
          // 최대 2년 뒤까지만 예약 가능
          if (Number.isFinite(t) && t > Date.now() && t < Date.now() + 63072e6) deliverAt = t;
        }
        const id = newId();
        const rec = {
          ct,
          deliverAt,
          burn: !!body.burn,
          sentAt: Date.now(),
          openedAt: null,
        };
        await env.MAIL.put("l:" + id, JSON.stringify(rec), { expirationTtl: LETTER_TTL });
        return json({ id });
      }

      /* ---------- 편지 받기 ---------- */
      let m = path.match(/^\/letter\/([\w-]{6,40})$/);
      if (req.method === "GET" && m) {
        const raw = await env.MAIL.get("l:" + m[1]);
        if (!raw) return json({ gone: true });
        const rec = JSON.parse(raw);
        if (rec.burned || !rec.ct) return json({ gone: true, burned: true });
        if (rec.deliverAt && Date.now() < rec.deliverAt) {
          return json({ pending: true, deliverAt: rec.deliverAt });
        }
        return json({ ct: rec.ct, burn: rec.burn, sentAt: rec.sentAt });
      }

      /* ---------- 개봉 도장 (+ 소각) ---------- */
      m = path.match(/^\/letter\/([\w-]{6,40})\/open$/);
      if (req.method === "POST" && m) {
        const key = "l:" + m[1];
        const raw = await env.MAIL.get(key);
        if (!raw) return json({ gone: true });
        const rec = JSON.parse(raw);
        if (rec.deliverAt && Date.now() < rec.deliverAt) {
          return json({ pending: true, deliverAt: rec.deliverAt });
        }
        if (rec.burn) {
          // 읽었으니 태운다 — 본문은 지우고 개봉 기록만 남긴다
          const ash = { burned: true, openedAt: Date.now(), sentAt: rec.sentAt };
          await env.MAIL.put(key, JSON.stringify(ash), { expirationTtl: 60 * 60 * 24 * 30 });
          return json({ ok: true, burned: true });
        }
        if (!rec.openedAt) {
          rec.openedAt = Date.now();
          await env.MAIL.put(key, JSON.stringify(rec), { expirationTtl: LETTER_TTL });
        }
        return json({ ok: true, openedAt: rec.openedAt });
      }

      /* ---------- 보낸 편지 상태 ---------- */
      m = path.match(/^\/letter\/([\w-]{6,40})\/status$/);
      if (req.method === "GET" && m) {
        const raw = await env.MAIL.get("l:" + m[1]);
        if (!raw) return json({ gone: true });
        const rec = JSON.parse(raw);
        return json({
          openedAt: rec.openedAt || null,
          burned: !!rec.burned,
          deliverAt: rec.deliverAt || null,
          sentAt: rec.sentAt || null,
        });
      }

      /* ---------- 촛불 (프레즌스) ---------- */
      m = path.match(/^\/presence\/([\w-]{4,64})$/);
      if (m) {
        const pair = m[1];
        if (req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          const me = String((body && body.me) || "").slice(0, 24);
          if (!ID_RE.test(me)) return json({ error: "bad_me" }, 400);
          await env.MAIL.put(`p:${pair}:${me}`, String(Date.now()), {
            expirationTtl: PRESENCE_TTL,
          });
          return json({ ok: true });
        }
        if (req.method === "GET") {
          const me = String(url.searchParams.get("me") || "").slice(0, 24);
          const list = await env.MAIL.list({ prefix: `p:${pair}:` });
          const partner = list.keys.some((k) => k.name !== `p:${pair}:${me}`);
          return json({ partner });
        }
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "oops" }, 500);
    }
  },
};
