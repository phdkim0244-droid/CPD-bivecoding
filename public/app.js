(function () {
  "use strict";

  const STORAGE_KEY = "vibe:state";
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // 상태
  // ---------------------------------------------------------------------
  const state = {
    token: null,
    session: null, // { code, label, nickname, maxTurns, turnsUsed }
    transcript: [], // { role: 'user'|'assistant'|'system'|'error', text, meta? }
    currentHtml: "",
    priorPrompts: [],
    workId: null, // 이번 앱을 서버에 저장했다면 그 id (다시 저장하면 덮어씀)
    workTitle: "",
    busy: false,
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      Object.assign(state, saved, { busy: false });
    } catch {
      /* 저장소를 못 써도 동작하게 */
    }
  }
  function persist() {
    try {
      const { busy, ...rest } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------
  async function api(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (state.token) headers["x-participant-token"] = state.token;
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || "요청에 실패했습니다.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------
  // 응답 파싱: 설명 + ```html 코드 블록
  // ---------------------------------------------------------------------
  function parseResponse(text) {
    const fenceStart = text.search(/```html\s*\n/);
    if (fenceStart === -1) return { explanation: text.trim(), html: null, open: false };
    const explanation = text.slice(0, fenceStart).trim();
    const afterFence = text.slice(fenceStart).replace(/^```html\s*\n/, "");
    const fenceEnd = afterFence.indexOf("\n```");
    if (fenceEnd === -1) return { explanation, html: afterFence, open: true };
    return { explanation, html: afterFence.slice(0, fenceEnd), open: false };
  }

  // ---------------------------------------------------------------------
  // 화면 요소
  // ---------------------------------------------------------------------
  const joinView = $("join");
  const appView = $("app");
  const messagesEl = $("messages");
  const promptEl = $("prompt");
  const previewEl = $("preview");
  const codeEl = $("code");

  function showJoin() {
    joinView.classList.remove("hidden");
    appView.classList.add("hidden");
    const params = new URLSearchParams(location.search);
    if (params.get("code")) $("code").value = params.get("code").toUpperCase();
  }

  function showApp() {
    joinView.classList.add("hidden");
    appView.classList.remove("hidden");
    renderSession();
    renderTranscript();
    renderPreview();
    renderTemplates();
  }

  function renderSession() {
    const s = state.session || {};
    $("labelText").textContent = s.label ? `· ${s.label}` : "";
    $("nickText").textContent = s.nickname || "";
    $("turnsUsed").textContent = s.turnsUsed ?? 0;
    $("maxTurns").textContent = s.maxTurns ?? "-";
    $("btnGallery").href = `/gallery.html?code=${encodeURIComponent(s.code || "")}`;
  }

  function renderTemplates() {
    const chips = $("chips");
    chips.innerHTML = "";
    (window.VIBE_TEMPLATES || []).forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = t.title;
      b.addEventListener("click", () => {
        promptEl.value = t.prompt;
        promptEl.focus();
        state.workTitle = state.workTitle || t.title;
      });
      chips.appendChild(b);
    });
  }

  function bubble(role, text) {
    const div = document.createElement("div");
    div.className = `msg-bubble msg-${role}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function renderTranscript() {
    messagesEl.innerHTML = "";
    if (!state.transcript.length) {
      bubble("system", "예시를 누르거나, 만들고 싶은 앱을 우리말로 써서 보내 보세요.");
    }
    state.transcript.forEach((m) => {
      const el = bubble(m.role, m.text);
      if (m.meta) {
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = m.meta;
        el.appendChild(meta);
      }
    });
  }

  function renderPreview() {
    const has = !!state.currentHtml;
    $("previewEmpty").classList.toggle("hidden", has);
    previewEl.srcdoc = has ? state.currentHtml : "";
    codeEl.textContent = state.currentHtml || "";
    ["btnDownload", "btnSave", "btnOpen", "btnReload"].forEach((id) => ($(id).disabled = !has));
  }

  function setTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    previewEl.classList.toggle("hidden", name !== "preview");
    codeEl.classList.toggle("hidden", name !== "code");
  }

  // ---------------------------------------------------------------------
  // 입장 / 나가기
  // ---------------------------------------------------------------------
  $("joinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("joinMsg");
    msg.textContent = "";
    try {
      const data = await api("/api/join", {
        method: "POST",
        body: JSON.stringify({ code: $("code").value, nickname: $("nickname").value }),
      });
      state.token = data.token;
      state.session = data;
      state.transcript = [];
      state.currentHtml = "";
      state.priorPrompts = [];
      state.workId = null;
      state.workTitle = "";
      persist();
      showApp();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  $("btnLeave").addEventListener("click", () => {
    if (!confirm("나가면 이 기기의 대화와 앱이 지워집니다. 저장한 작품은 갤러리에 남아 있어요. 나갈까요?")) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    location.href = "/";
  });

  $("btnNew").addEventListener("click", () => {
    if (state.currentHtml && !confirm("지금 만든 앱을 비우고 처음부터 시작할까요? (저장하지 않은 앱은 사라집니다)")) return;
    state.transcript = [];
    state.currentHtml = "";
    state.priorPrompts = [];
    state.workId = null;
    state.workTitle = "";
    persist();
    renderTranscript();
    renderPreview();
    promptEl.focus();
  });

  // ---------------------------------------------------------------------
  // 요청 보내기 (SSE 스트리밍)
  // ---------------------------------------------------------------------
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  async function send() {
    const prompt = promptEl.value.trim();
    if (!prompt || state.busy) return;
    state.busy = true;
    $("btnSend").disabled = true;
    promptEl.value = "";

    state.transcript.push({ role: "user", text: prompt });
    bubble("user", prompt);
    const assistantEl = bubble("assistant", "");
    const textNode = document.createTextNode("");
    const cursor = document.createElement("span");
    cursor.className = "typing";
    cursor.textContent = "▍";
    assistantEl.append(textNode, cursor);
    $("building").classList.remove("hidden");
    $("buildingChars").textContent = "0";

    let full = "";
    let done = null;
    let errorMessage = null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-participant-token": state.token },
        body: JSON.stringify({ prompt, currentHtml: state.currentHtml, priorPrompts: state.priorPrompts }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "요청에 실패했습니다.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let lastRender = 0;

      while (true) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        pending += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, idx);
          pending = pending.slice(idx + 2);
          const ev = parseFrame(frame);
          if (!ev) continue;
          if (ev.event === "delta") {
            full += ev.data.text;
            const nowMs = Date.now();
            if (nowMs - lastRender > 80) {
              lastRender = nowMs;
              const parsed = parseResponse(full);
              textNode.nodeValue = parsed.explanation;
              if (parsed.html !== null) {
                codeEl.textContent = parsed.html;
                $("buildingChars").textContent = String(parsed.html.length);
              }
            }
          } else if (ev.event === "done") {
            done = ev.data;
          } else if (ev.event === "error") {
            errorMessage = ev.data.message;
          }
        }
      }
    } catch (err) {
      errorMessage = err.message;
    }

    cursor.remove();
    $("building").classList.add("hidden");

    const parsed = parseResponse(full);
    if (errorMessage && !full) {
      assistantEl.remove();
      state.transcript.pop();
      state.transcript.push({ role: "error", text: errorMessage });
      bubble("error", errorMessage);
      promptEl.value = prompt;
    } else {
      let meta = "";
      if (done && done.truncated) meta = "응답이 길어 잘렸습니다. '이어서 완성해 줘'라고 요청해 보세요.";
      else if (done && done.stopReason === "refusal") meta = "이 요청은 처리할 수 없다고 응답했습니다. 다른 방식으로 요청해 보세요.";
      else if (errorMessage) meta = errorMessage;

      const text = parsed.explanation || (parsed.html ? "앱을 만들었습니다." : "(응답 없음)");
      textNode.nodeValue = text;
      state.transcript.push({ role: "assistant", text, meta: meta || undefined });
      if (meta) {
        const m = document.createElement("span");
        m.className = "meta";
        m.textContent = meta;
        assistantEl.appendChild(m);
      }
      if (parsed.html && parsed.html.trim()) {
        state.currentHtml = parsed.html.trim();
        state.priorPrompts = state.priorPrompts.concat(prompt).slice(-8);
        renderPreview();
        setTab("preview");
      }
      if (done) {
        state.session.turnsUsed = done.turnsUsed;
        state.session.maxTurns = done.maxTurns;
        renderSession();
      }
    }

    persist();
    state.busy = false;
    $("btnSend").disabled = false;
    promptEl.focus();
  }

  function parseFrame(frame) {
    let event = "message";
    let data = "";
    frame.split("\n").forEach((line) => {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    });
    if (!data) return null;
    try {
      return { event, data: JSON.parse(data) };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // 미리보기 도구
  // ---------------------------------------------------------------------
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
  $("btnReload").addEventListener("click", () => renderPreview());
  $("btnOpen").addEventListener("click", () => {
    const blob = new Blob([state.currentHtml], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank");
  });
  $("btnDownload").addEventListener("click", () => {
    const blob = new Blob([state.currentHtml], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.workTitle || "my-app").replace(/[\\/:*?"<>|]/g, "_")}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------------------------------------------------------------------
  // 저장 · 공유
  // ---------------------------------------------------------------------
  $("btnSave").addEventListener("click", () => {
    $("workTitle").value = state.workTitle || (state.priorPrompts[0] || "").slice(0, 30);
    $("saveSubmit").textContent = state.workId ? "덮어쓰기" : "저장하기";
    $("saveModal").classList.remove("hidden");
    $("workTitle").focus();
  });
  $("saveCancel").addEventListener("click", () => $("saveModal").classList.add("hidden"));
  $("saveForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("saveSubmit");
    btn.disabled = true;
    try {
      const body = JSON.stringify({ title: $("workTitle").value, description: $("workDesc").value, html: state.currentHtml });
      const data = state.workId
        ? await api(`/api/works/${state.workId}`, { method: "PUT", body })
        : await api("/api/works", { method: "POST", body });
      state.workId = data.id;
      state.workTitle = $("workTitle").value.trim();
      persist();
      $("saveModal").classList.add("hidden");
      showShare(`${location.origin}${data.url}`);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  function showShare(url) {
    $("shareUrl").textContent = url;
    $("shareUrl").href = url;
    const qrEl = $("qr");
    qrEl.innerHTML = "";
    try {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      qrEl.innerHTML = qr.createImgTag(5, 8);
    } catch {
      /* QR 생성 실패 시 주소만 표시 */
    }
    $("shareModal").classList.remove("hidden");
  }
  $("shareClose").addEventListener("click", () => $("shareModal").classList.add("hidden"));
  $("shareCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("shareUrl").textContent);
      $("shareCopy").textContent = "복사됨!";
      setTimeout(() => ($("shareCopy").textContent = "주소 복사"), 1500);
    } catch {
      /* ignore */
    }
  });

  // ---------------------------------------------------------------------
  // 내 작품
  // ---------------------------------------------------------------------
  $("btnMyWorks").addEventListener("click", async () => {
    const list = $("worksList");
    list.innerHTML = "<li>불러오는 중…</li>";
    $("worksModal").classList.remove("hidden");
    try {
      const data = await api("/api/works");
      list.innerHTML = "";
      if (!data.works.length) list.innerHTML = "<li>아직 저장한 작품이 없습니다.</li>";
      data.works.forEach((w) => {
        const li = document.createElement("li");
        const t = document.createElement("div");
        t.className = "t";
        t.innerHTML = `<b></b><small></small>`;
        t.querySelector("b").textContent = w.title;
        t.querySelector("small").textContent = new Date(w.updated_at * 1000).toLocaleString("ko-KR");
        const open = document.createElement("a");
        open.className = "btn btn-sm";
        open.textContent = "열기";
        open.href = `/w/${w.id}`;
        open.target = "_blank";
        const share = document.createElement("button");
        share.className = "btn btn-sm";
        share.textContent = "QR";
        share.type = "button";
        share.addEventListener("click", () => showShare(`${location.origin}/w/${w.id}`));
        const del = document.createElement("button");
        del.className = "btn btn-sm";
        del.textContent = "삭제";
        del.type = "button";
        del.addEventListener("click", async () => {
          if (!confirm(`'${w.title}' 작품을 삭제할까요?`)) return;
          await api(`/api/works/${w.id}`, { method: "DELETE" });
          if (state.workId === w.id) state.workId = null;
          persist();
          li.remove();
        });
        li.append(t, open, share, del);
        list.appendChild(li);
      });
    } catch (err) {
      list.innerHTML = `<li>${err.message}</li>`;
    }
  });
  $("worksClose").addEventListener("click", () => $("worksModal").classList.add("hidden"));

  // ---------------------------------------------------------------------
  // 시작
  // ---------------------------------------------------------------------
  async function init() {
    load();
    if (!state.token) return showJoin();
    try {
      state.session = await api("/api/me");
      persist();
      showApp();
    } catch (err) {
      state.token = null;
      persist();
      showJoin();
      $("joinMsg").textContent = err.message;
    }
  }
  init();
})();
