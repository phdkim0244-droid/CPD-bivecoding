(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let password = "";
  let usdToKrw = 1400;
  let selected = null;
  let codesCache = [];

  try {
    password = sessionStorage.getItem("vibe:admin") || "";
  } catch {
    /* ignore */
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { "content-type": "application/json", authorization: `Bearer ${password}`, ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "요청 실패");
    return data;
  }

  const fmtTime = (s) => new Date(s * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmtMoney = (usd) => `$${Number(usd).toFixed(2)} (약 ${Math.round(usd * usdToKrw).toLocaleString("ko-KR")}원)`;

  // 로그인 ---------------------------------------------------------------
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    password = $("password").value;
    try {
      await api("/api/admin/login", { method: "POST" });
      sessionStorage.setItem("vibe:admin", password);
      enter();
    } catch (err) {
      $("loginMsg").textContent = err.message;
    }
  });

  function enter() {
    $("loginCard").classList.add("hidden");
    $("dash").classList.remove("hidden");
    loadCodes();
  }

  // 코드 생성 / 목록 ---------------------------------------------------------
  $("createForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = await api("/api/admin/codes", {
      method: "POST",
      body: JSON.stringify({
        label: $("label").value,
        hours: Number($("hours").value),
        maxTurnsPerUser: Number($("maxTurns").value),
        perMinute: Number($("perMinute").value),
        budgetUsd: Number($("budget").value),
        model: $("model").value,
        effort: $("effort").value,
      }),
    });
    await loadCodes();
    select(data.code);
  });
  $("btnReload").addEventListener("click", () => {
    loadCodes();
    if (selected) loadDetail(selected);
  });

  async function loadCodes() {
    const data = await api("/api/admin/codes");
    usdToKrw = data.usdToKrw;
    codesCache = data.codes;
    $("rate").textContent = `(환율 1달러 = ${usdToKrw.toLocaleString("ko-KR")}원 기준)`;
    const body = $("codesBody");
    body.innerHTML = "";
    data.codes.forEach((c) => {
      const tr = document.createElement("tr");
      if (c.code === selected) tr.classList.add("selected");
      const expired = c.expires_at < data.now;
      const pill = !c.active ? '<span class="pill off">중지</span>' : expired ? '<span class="pill exp">만료</span>' : '<span class="pill on">진행</span>';
      tr.innerHTML = `
        <td class="code-big"></td><td></td><td>${pill}</td><td></td>
        <td></td><td></td><td></td><td></td><td></td>
        <td><button class="btn btn-sm" type="button">상세</button></td>`;
      const tds = tr.querySelectorAll("td");
      tds[0].textContent = c.code;
      tds[1].textContent = c.label;
      tds[3].textContent = fmtTime(c.expires_at);
      tds[4].textContent = c.participants;
      tds[5].textContent = c.errors ? `${c.turns} (오류 ${c.errors})` : c.turns;
      tds[6].textContent = c.works;
      tds[7].textContent = `$${Number(c.spend_usd).toFixed(2)} / $${c.budget_usd}`;
      tds[8].textContent = `${c.model.replace("claude-", "")} / ${c.effort}`;
      tr.querySelector("button").addEventListener("click", () => select(c.code));
      body.appendChild(tr);
    });
  }

  function select(code) {
    selected = code;
    document.querySelectorAll("#codesBody tr").forEach((tr) => tr.classList.toggle("selected", tr.firstElementChild.textContent === code));
    loadDetail(code);
  }

  // 상세 -----------------------------------------------------------------
  async function loadDetail(code) {
    const c = codesCache.find((x) => x.code === code);
    if (!c) return;
    $("detailCard").classList.remove("hidden");
    $("detailCode").textContent = code;
    $("detailLabel").textContent = c.label;
    $("linkGallery").href = `/gallery.html?code=${code}`;
    $("linkJoin").href = `/?code=${code}`;
    $("linkCsv").href = `/api/admin/codes/${code}/turns?format=csv`;
    $("btnToggle").textContent = c.active ? "일시 중지" : "다시 열기";

    $("detailStats").innerHTML = [
      ["참가자", c.participants],
      ["요청 수", c.turns],
      ["작품 수", c.works],
      ["사용 비용", fmtMoney(c.spend_usd)],
      ["예산", `$${c.budget_usd}`],
      ["1인 횟수 제한", `${c.max_turns_per_user}회 (분당 ${c.per_minute})`],
    ]
      .map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`)
      .join("");

    const [p, w, t] = await Promise.all([
      api(`/api/admin/codes/${code}/participants`),
      api(`/api/admin/codes/${code}/works`),
      api(`/api/admin/codes/${code}/turns`),
    ]);

    const pb = $("participantsBody");
    pb.innerHTML = "";
    if (!p.participants.length) pb.innerHTML = "<tr><td colspan=6>아직 참가자가 없습니다.</td></tr>";
    p.participants.forEach((x) => {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td></td><td></td><td></td><td></td><td></td><td></td>";
      const tds = tr.querySelectorAll("td");
      tds[0].textContent = x.nickname;
      tds[1].textContent = x.turns;
      tds[2].textContent = x.errors;
      tds[3].textContent = x.works;
      tds[4].textContent = `$${Number(x.spend_usd).toFixed(3)}`;
      tds[5].textContent = fmtTime(x.last_seen);
      pb.appendChild(tr);
    });

    const wb = $("worksBody");
    wb.innerHTML = "";
    if (!w.works.length) wb.innerHTML = "<tr><td colspan=5>아직 저장된 작품이 없습니다.</td></tr>";
    w.works.forEach((x) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td></td><td></td><td></td><td></td>
        <td class="row-actions"><a class="btn btn-sm" target="_blank">열기</a><button class="btn btn-sm" type="button">삭제</button></td>`;
      const tds = tr.querySelectorAll("td");
      tds[0].textContent = x.title;
      tds[1].textContent = x.nickname;
      tds[2].textContent = x.description;
      tds[3].textContent = fmtTime(x.updated_at);
      tr.querySelector("a").href = `/w/${x.id}`;
      tr.querySelector("button").addEventListener("click", async () => {
        if (!confirm(`'${x.title}' 작품을 삭제할까요?`)) return;
        await api(`/api/admin/works/${x.id}`, { method: "DELETE" });
        loadDetail(code);
      });
      wb.appendChild(tr);
    });

    const tb = $("turnsBox");
    tb.innerHTML = "";
    if (!t.turns.length) tb.innerHTML = "<p>아직 대화 기록이 없습니다.</p>";
    t.turns.forEach((x) => {
      const d = document.createElement("div");
      d.className = "turn";
      const explanation = (x.response || "").split("```")[0].trim();
      d.innerHTML = `<div class="p"></div><div class="r"></div><div class="m"></div>`;
      d.querySelector(".p").textContent = `${x.nickname}: ${x.prompt}`;
      d.querySelector(".r").textContent = x.error ? `[오류] ${x.error}` : explanation;
      d.querySelector(".m").textContent = `${fmtTime(x.created_at)} · ${x.model} · 입력 ${x.input_tokens} / 출력 ${x.output_tokens} 토큰 · $${Number(x.cost_usd).toFixed(4)}${x.stop_reason && x.stop_reason !== "end_turn" ? ` · ${x.stop_reason}` : ""}`;
      tb.appendChild(d);
    });
  }

  async function patch(body) {
    await api(`/api/admin/codes/${selected}`, { method: "PATCH", body: JSON.stringify(body) });
    await loadCodes();
    loadDetail(selected);
  }
  $("btnToggle").addEventListener("click", () => {
    const c = codesCache.find((x) => x.code === selected);
    patch({ active: !c.active });
  });
  $("btnExtend").addEventListener("click", () => patch({ extendHours: 3 }));
  $("btnBudget").addEventListener("click", () => {
    const v = prompt("새 예산 상한(USD)을 입력하세요.");
    if (v && Number(v) > 0) patch({ budgetUsd: Number(v) });
  });
  $("btnTurnsLimit").addEventListener("click", () => {
    const v = prompt("1인당 요청 횟수 제한을 입력하세요.");
    if (v && Number(v) > 0) patch({ maxTurnsPerUser: Number(v) });
  });

  if (password) {
    api("/api/admin/login", { method: "POST" }).then(enter).catch(() => {});
  }
})();
