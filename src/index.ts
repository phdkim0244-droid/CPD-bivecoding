import type { CodeRow, Effort, Env, ParticipantRow, WorkRow } from "./types";
import { mockStreamChat, streamChat } from "./claude";
import { csvEscape, error, generateCode, isAdmin, json, normalizeCode, now, readJson, shortId } from "./util";

const EFFORTS: Effort[] = ["low", "medium", "high"];
const MAX_PROMPT_CHARS = 2000;
const MAX_HTML_CHARS = 200_000;
const MAX_NICKNAME_CHARS = 20;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/api/admin/")) return await adminRoutes(request, env, path);
      if (path.startsWith("/api/")) return await apiRoutes(request, env, ctx, path);
      if (path.startsWith("/w/")) return await serveWork(env, path.slice(3));
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return error("서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.", 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// 참가자 API
// ---------------------------------------------------------------------------

async function apiRoutes(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const m = request.method;

  if (path === "/api/join" && m === "POST") return join(request, env);
  if (path === "/api/me" && m === "GET") return me(request, env);
  if (path === "/api/chat" && m === "POST") return chat(request, env, ctx);
  if (path === "/api/works" && m === "GET") return listMyWorks(request, env);
  if (path === "/api/works" && m === "POST") return saveWork(request, env);
  if (path.startsWith("/api/works/") && m === "PUT") return saveWork(request, env, path.slice(11));
  if (path.startsWith("/api/works/") && m === "DELETE") return deleteWork(request, env, path.slice(11));
  if (path === "/api/gallery" && m === "GET") return gallery(request, env);

  return error("알 수 없는 요청입니다.", 404);
}

async function getCode(env: Env, code: string): Promise<CodeRow | null> {
  return env.DB.prepare("SELECT * FROM codes WHERE code = ?").bind(code).first<CodeRow>();
}

function codeProblem(row: CodeRow | null): string | null {
  if (!row) return "연수 코드가 없습니다. 강사에게 코드를 다시 확인해 주세요.";
  if (!row.active) return "이 연수 코드는 강사가 일시 중지했습니다.";
  if (row.expires_at < now()) return "이 연수 코드는 유효 기간이 끝났습니다.";
  return null;
}

async function authParticipant(
  request: Request,
  env: Env,
): Promise<{ participant: ParticipantRow; codeRow: CodeRow } | Response> {
  const token = request.headers.get("x-participant-token") ?? "";
  if (!token) return error("다시 입장해 주세요.", 401);
  const participant = await env.DB.prepare("SELECT * FROM participants WHERE id = ?").bind(token).first<ParticipantRow>();
  if (!participant) return error("세션이 만료되었습니다. 다시 입장해 주세요.", 401);
  const codeRow = await getCode(env, participant.code);
  const problem = codeProblem(codeRow);
  if (problem || !codeRow) return error(problem ?? "연수 코드 오류", 403);
  return { participant, codeRow };
}

async function join(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ code?: string; nickname?: string }>(request);
  const code = normalizeCode(body?.code);
  const nickname = String(body?.nickname ?? "").trim().slice(0, MAX_NICKNAME_CHARS);
  if (code.length < 4) return error("연수 코드를 입력해 주세요.");
  if (!nickname) return error("닉네임을 입력해 주세요.");

  const codeRow = await getCode(env, code);
  const problem = codeProblem(codeRow);
  if (problem || !codeRow) return error(problem ?? "연수 코드 오류", 403);

  const existing = await env.DB.prepare("SELECT id FROM participants WHERE code = ? AND nickname = ?")
    .bind(code, nickname)
    .first<{ id: string }>();
  if (existing) return error("이미 사용 중인 닉네임입니다. 다른 닉네임을 써 주세요.", 409);

  const id = crypto.randomUUID();
  const t = now();
  await env.DB.prepare("INSERT INTO participants (id, code, nickname, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
    .bind(id, code, nickname, t, t)
    .run();

  return json({ token: id, ...sessionInfo(codeRow, nickname, 0) });
}

function sessionInfo(codeRow: CodeRow, nickname: string, turnsUsed: number) {
  return {
    code: codeRow.code,
    label: codeRow.label,
    nickname,
    model: codeRow.model,
    maxTurns: codeRow.max_turns_per_user,
    turnsUsed,
    expiresAt: codeRow.expires_at,
  };
}

async function countTurns(env: Env, participantId: string, since = 0): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM turns WHERE participant_id = ? AND created_at >= ? AND error IS NULL",
  )
    .bind(participantId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function codeSpend(env: Env, code: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM turns WHERE code = ?")
    .bind(code)
    .first<{ s: number }>();
  return row?.s ?? 0;
}

async function me(request: Request, env: Env): Promise<Response> {
  const auth = await authParticipant(request, env);
  if (auth instanceof Response) return auth;
  const used = await countTurns(env, auth.participant.id);
  return json(sessionInfo(auth.codeRow, auth.participant.nickname, used));
}

async function chat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authParticipant(request, env);
  if (auth instanceof Response) return auth;
  const { participant, codeRow } = auth;

  const body = await readJson<{ prompt?: string; currentHtml?: string; priorPrompts?: string[] }>(request);
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return error("요청 내용을 입력해 주세요.");
  if (prompt.length > MAX_PROMPT_CHARS) return error(`요청은 ${MAX_PROMPT_CHARS}자 이내로 써 주세요.`);
  const currentHtml = String(body?.currentHtml ?? "").slice(0, MAX_HTML_CHARS);
  const priorPrompts = Array.isArray(body?.priorPrompts)
    ? body!.priorPrompts.map((p) => String(p).slice(0, 200)).slice(-8)
    : [];

  // 사용량 제한: 분당 횟수 → 1인 총 횟수 → 연수 전체 예산
  const t = now();
  const lastMinute = await countTurns(env, participant.id, t - 60);
  if (lastMinute >= codeRow.per_minute) {
    return error(`요청이 너무 잦습니다. 1분에 ${codeRow.per_minute}회까지 보낼 수 있어요. 잠시 후 다시 시도해 주세요.`, 429);
  }
  const total = await countTurns(env, participant.id);
  if (total >= codeRow.max_turns_per_user) {
    return error(`1인당 요청 횟수(${codeRow.max_turns_per_user}회)를 모두 사용했습니다. 강사에게 말씀해 주세요.`, 429);
  }
  const spend = await codeSpend(env, codeRow.code);
  if (spend >= codeRow.budget_usd) {
    return error("이 연수의 사용 예산이 모두 소진되었습니다. 강사에게 말씀해 주세요.", 429);
  }

  if (!env.ANTHROPIC_API_KEY && env.MOCK_AI !== "1") {
    return error("서버에 API 키가 설정되어 있지 않습니다. 강사에게 말씀해 주세요.", 500);
  }

  ctx.waitUntil(
    env.DB.prepare("UPDATE participants SET last_seen = ? WHERE id = ?").bind(t, participant.id).run(),
  );

  // SSE 스트리밍 응답
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event: string, data: unknown) =>
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  // 무료 요금제의 CPU 시간을 아끼기 위해 글자를 모아서 내보냅니다.
  let buffer = "";
  let lastFlush = Date.now();
  const flush = async () => {
    if (!buffer) return;
    const chunk = buffer;
    buffer = "";
    lastFlush = Date.now();
    await send("delta", { text: chunk });
  };
  const onText = async (chunk: string) => {
    buffer += chunk;
    if (buffer.length >= 240 || Date.now() - lastFlush > 120) await flush();
  };

  const run = async () => {
    const effort = EFFORTS.includes(codeRow.effort) ? codeRow.effort : "medium";
    const input = { prompt, currentHtml, priorPrompts };
    try {
      await send("start", { model: codeRow.model, turnsUsed: total, maxTurns: codeRow.max_turns_per_user });
      const result =
        env.MOCK_AI === "1"
          ? await mockStreamChat({ model: codeRow.model, effort, input, onText })
          : await streamChat({ apiKey: env.ANTHROPIC_API_KEY, model: codeRow.model, effort, input, onText });
      await flush();

      await env.DB.prepare(
        `INSERT INTO turns (code, participant_id, created_at, prompt, response, model, stop_reason,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          codeRow.code,
          participant.id,
          t,
          prompt,
          result.text,
          result.servedModel,
          result.stopReason,
          result.usage.input_tokens,
          result.usage.output_tokens,
          result.usage.cache_read_tokens,
          result.usage.cache_write_tokens,
          result.usage.cost_usd,
        )
        .run();

      await send("done", {
        stopReason: result.stopReason,
        refusalCategory: result.refusalCategory,
        truncated: result.stopReason === "max_tokens",
        usage: result.usage,
        turnsUsed: total + 1,
        maxTurns: codeRow.max_turns_per_user,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("chat error", message);
      await env.DB.prepare(
        "INSERT INTO turns (code, participant_id, created_at, prompt, model, error) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(codeRow.code, participant.id, t, prompt, codeRow.model, message.slice(0, 500))
        .run()
        .catch(() => {});
      await send("error", { message: friendlyApiError(message) }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  };
  ctx.waitUntil(run());

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function friendlyApiError(message: string): string {
  if (/401|authentication/i.test(message)) return "API 키가 올바르지 않습니다. 강사에게 말씀해 주세요.";
  if (/429|rate.?limit/i.test(message)) return "지금 요청이 몰려 있습니다. 10초쯤 뒤에 다시 보내 주세요.";
  if (/overloaded|529|503/i.test(message)) return "AI 서버가 잠시 바쁩니다. 조금 뒤에 다시 시도해 주세요.";
  return "응답을 받지 못했습니다. 다시 한 번 보내 주세요.";
}

// ---------------------------------------------------------------------------
// 작품 저장 / 갤러리
// ---------------------------------------------------------------------------

async function listMyWorks(request: Request, env: Env): Promise<Response> {
  const auth = await authParticipant(request, env);
  if (auth instanceof Response) return auth;
  const rows = await env.DB.prepare(
    "SELECT id, nickname, title, description, created_at, updated_at FROM works WHERE participant_id = ? ORDER BY updated_at DESC",
  )
    .bind(auth.participant.id)
    .all<Omit<WorkRow, "html" | "code" | "participant_id">>();
  return json({ works: rows.results });
}

async function saveWork(request: Request, env: Env, id?: string): Promise<Response> {
  const auth = await authParticipant(request, env);
  if (auth instanceof Response) return auth;
  const { participant, codeRow } = auth;

  const body = await readJson<{ title?: string; description?: string; html?: string }>(request);
  const title = String(body?.title ?? "").trim().slice(0, 60) || "제목 없는 작품";
  const description = String(body?.description ?? "").trim().slice(0, 300);
  const html = String(body?.html ?? "");
  if (!html.trim()) return error("저장할 앱이 없습니다. 먼저 앱을 만들어 주세요.");
  if (html.length > MAX_HTML_CHARS) return error("앱 코드가 너무 큽니다.");

  const t = now();
  if (id) {
    const existing = await env.DB.prepare("SELECT participant_id FROM works WHERE id = ?").bind(id).first<{ participant_id: string }>();
    if (!existing) return error("작품을 찾을 수 없습니다.", 404);
    if (existing.participant_id !== participant.id) return error("내 작품만 수정할 수 있습니다.", 403);
    await env.DB.prepare("UPDATE works SET title = ?, description = ?, html = ?, updated_at = ? WHERE id = ?")
      .bind(title, description, html, t, id)
      .run();
    return json({ id, url: `/w/${id}` });
  }

  const newId = shortId();
  await env.DB.prepare(
    "INSERT INTO works (id, code, participant_id, nickname, title, description, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId, codeRow.code, participant.id, participant.nickname, title, description, html, t, t)
    .run();
  return json({ id: newId, url: `/w/${newId}` });
}

async function deleteWork(request: Request, env: Env, id: string): Promise<Response> {
  if (isAdmin(request, env)) {
    await env.DB.prepare("DELETE FROM works WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  const auth = await authParticipant(request, env);
  if (auth instanceof Response) return auth;
  const res = await env.DB.prepare("DELETE FROM works WHERE id = ? AND participant_id = ?").bind(id, auth.participant.id).run();
  if (!res.meta.changes) return error("내 작품만 삭제할 수 있습니다.", 403);
  return json({ ok: true });
}

async function gallery(request: Request, env: Env): Promise<Response> {
  const code = normalizeCode(new URL(request.url).searchParams.get("code"));
  const codeRow = await getCode(env, code);
  if (!codeRow) return error("연수 코드가 없습니다.", 404);
  const rows = await env.DB.prepare(
    "SELECT id, nickname, title, description, updated_at FROM works WHERE code = ? ORDER BY updated_at DESC LIMIT 200",
  )
    .bind(code)
    .all();
  return json({ label: codeRow.label, code, works: rows.results });
}

async function serveWork(env: Env, id: string): Promise<Response> {
  const clean = id.replace(/[^a-z0-9]/g, "");
  const row = await env.DB.prepare("SELECT html FROM works WHERE id = ?").bind(clean).first<{ html: string }>();
  if (!row) return new Response("작품을 찾을 수 없습니다.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(row.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 참가자가 만든 코드가 이 사이트의 저장소나 세션에 접근하지 못하도록 격리합니다.
      "content-security-policy": "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// 강사(관리자) API
// ---------------------------------------------------------------------------

async function adminRoutes(request: Request, env: Env, path: string): Promise<Response> {
  if (!isAdmin(request, env)) return error("관리자 비밀번호가 올바르지 않습니다.", 401);
  const m = request.method;
  const rest = path.slice("/api/admin/".length);
  const parts = rest.split("/").filter(Boolean);

  if (rest === "login" && m === "POST") return json({ ok: true });
  if (rest === "codes" && m === "GET") return adminListCodes(env);
  if (rest === "codes" && m === "POST") return adminCreateCode(request, env);

  if (parts[0] === "codes" && parts[1]) {
    const code = normalizeCode(parts[1]);
    const sub = parts[2] ?? "";
    if (!sub && m === "PATCH") return adminUpdateCode(request, env, code);
    if (sub === "participants" && m === "GET") return adminParticipants(env, code);
    if (sub === "turns" && m === "GET") return adminTurns(request, env, code);
    if (sub === "works" && m === "GET") return adminWorks(env, code);
  }
  if (parts[0] === "works" && parts[1] && m === "DELETE") return deleteWork(request, env, parts[1]);

  return error("알 수 없는 관리자 요청입니다.", 404);
}

async function adminListCodes(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM participants p WHERE p.code = c.code) AS participants,
       (SELECT COUNT(*) FROM turns t WHERE t.code = c.code AND t.error IS NULL) AS turns,
       (SELECT COUNT(*) FROM turns t WHERE t.code = c.code AND t.error IS NOT NULL) AS errors,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM turns t WHERE t.code = c.code) AS spend_usd,
       (SELECT COUNT(*) FROM works w WHERE w.code = c.code) AS works
     FROM codes c ORDER BY created_at DESC`,
  ).all();
  return json({ codes: rows.results, usdToKrw: Number(env.USD_TO_KRW) || 1400, now: now() });
}

async function adminCreateCode(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    label?: string;
    hours?: number;
    maxTurnsPerUser?: number;
    perMinute?: number;
    budgetUsd?: number;
    effort?: string;
    model?: string;
  }>(request);
  const label = String(body?.label ?? "").trim().slice(0, 60) || "바이브 코딩 연수";
  const hours = clamp(Number(body?.hours) || 6, 1, 24 * 30);
  const maxTurns = clamp(Number(body?.maxTurnsPerUser) || 60, 1, 1000);
  const perMinute = clamp(Number(body?.perMinute) || 6, 1, 60);
  const budget = clamp(Number(body?.budgetUsd) || 30, 1, 10000);
  const effort = EFFORTS.includes(body?.effort as Effort) ? (body!.effort as Effort) : (env.DEFAULT_EFFORT as Effort) || "medium";
  const model = String(body?.model ?? "").trim() || env.DEFAULT_MODEL || "claude-opus-5-5";

  let code = generateCode();
  for (let i = 0; i < 5 && (await getCode(env, code)); i++) code = generateCode();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO codes (code, label, created_at, expires_at, active, model, effort, max_turns_per_user, per_minute, budget_usd)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  )
    .bind(code, label, t, t + hours * 3600, model, effort, maxTurns, perMinute, budget)
    .run();
  return json({ code });
}

async function adminUpdateCode(request: Request, env: Env, code: string): Promise<Response> {
  const existing = await getCode(env, code);
  if (!existing) return error("연수 코드가 없습니다.", 404);
  const body = await readJson<{
    active?: boolean;
    extendHours?: number;
    maxTurnsPerUser?: number;
    perMinute?: number;
    budgetUsd?: number;
    effort?: string;
    model?: string;
    label?: string;
  }>(request);
  if (!body) return error("잘못된 요청입니다.");

  const next = {
    active: typeof body.active === "boolean" ? (body.active ? 1 : 0) : existing.active,
    expires_at: body.extendHours ? Math.max(existing.expires_at, now()) + clamp(Number(body.extendHours), 1, 24 * 30) * 3600 : existing.expires_at,
    max_turns_per_user: body.maxTurnsPerUser ? clamp(Number(body.maxTurnsPerUser), 1, 1000) : existing.max_turns_per_user,
    per_minute: body.perMinute ? clamp(Number(body.perMinute), 1, 60) : existing.per_minute,
    budget_usd: body.budgetUsd ? clamp(Number(body.budgetUsd), 1, 10000) : existing.budget_usd,
    effort: EFFORTS.includes(body.effort as Effort) ? (body.effort as Effort) : existing.effort,
    model: body.model ? String(body.model).trim() : existing.model,
    label: body.label ? String(body.label).trim().slice(0, 60) : existing.label,
  };
  await env.DB.prepare(
    `UPDATE codes SET active = ?, expires_at = ?, max_turns_per_user = ?, per_minute = ?, budget_usd = ?, effort = ?, model = ?, label = ? WHERE code = ?`,
  )
    .bind(next.active, next.expires_at, next.max_turns_per_user, next.per_minute, next.budget_usd, next.effort, next.model, next.label, code)
    .run();
  return json({ ok: true });
}

async function adminParticipants(env: Env, code: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.nickname, p.created_at, p.last_seen,
       (SELECT COUNT(*) FROM turns t WHERE t.participant_id = p.id AND t.error IS NULL) AS turns,
       (SELECT COUNT(*) FROM turns t WHERE t.participant_id = p.id AND t.error IS NOT NULL) AS errors,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM turns t WHERE t.participant_id = p.id) AS spend_usd,
       (SELECT COUNT(*) FROM works w WHERE w.participant_id = p.id) AS works
     FROM participants p WHERE p.code = ? ORDER BY p.last_seen DESC`,
  )
    .bind(code)
    .all();
  return json({ participants: rows.results });
}

async function adminTurns(request: Request, env: Env, code: string): Promise<Response> {
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  const rows = await env.DB.prepare(
    `SELECT t.id, t.created_at, p.nickname, t.prompt, t.response, t.model, t.stop_reason,
            t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.cost_usd, t.error
     FROM turns t JOIN participants p ON p.id = t.participant_id
     WHERE t.code = ? ORDER BY t.created_at ASC, t.id ASC`,
  )
    .bind(code)
    .all<Record<string, unknown>>();

  if (format === "csv") {
    const header = ["id", "시각", "닉네임", "요청", "응답(설명만)", "모델", "종료사유", "입력토큰", "출력토큰", "캐시읽기", "캐시쓰기", "비용USD", "오류"];
    const lines = [header.join(",")];
    for (const r of rows.results) {
      const response = String(r.response ?? "");
      const explanation = response.split("```")[0].trim();
      lines.push(
        [
          r.id,
          new Date(Number(r.created_at) * 1000).toISOString(),
          r.nickname,
          r.prompt,
          explanation,
          r.model,
          r.stop_reason,
          r.input_tokens,
          r.output_tokens,
          r.cache_read_tokens,
          r.cache_write_tokens,
          Number(r.cost_usd ?? 0).toFixed(4),
          r.error,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    return new Response("﻿" + lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="turns-${code}.csv"`,
      },
    });
  }
  return json({ turns: rows.results });
}

async function adminWorks(env: Env, code: string): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, nickname, title, description, created_at, updated_at, LENGTH(html) AS size FROM works WHERE code = ? ORDER BY updated_at DESC",
  )
    .bind(code)
    .all();
  return json({ works: rows.results });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
