(function () {
  "use strict";

  const screen = document.querySelector("#party-screen");
  const toast = document.querySelector("#toast");
  const connectionStatus = document.querySelector("#connection-status");
  const params = new URLSearchParams(location.search);
  let credentials = null;
  let socket = null;
  let state = null;
  let secretVisible = false;
  let selectedVote = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let intentionalClose = false;

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function setScreen(html) {
    screen.innerHTML = html;
    screen.classList.remove("screen");
    void screen.offsetWidth;
    screen.classList.add("screen");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function setConnection(label, offline = false) {
    connectionStatus.hidden = !label;
    connectionStatus.textContent = label;
    connectionStatus.classList.toggle("offline", offline);
  }

  const storageKey = (code) => `undercover-room-${code}`;

  function saveCredentials(value) {
    credentials = value;
    localStorage.setItem(storageKey(value.room_code), JSON.stringify(value));
    localStorage.setItem("undercover-current-room", value.room_code);
    history.replaceState({}, "", `/party?room=${value.room_code}`);
  }

  function loadCredentials(code) {
    try { return JSON.parse(localStorage.getItem(storageKey(code))); }
    catch { return null; }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || "تعذر إكمال الطلب.");
    return body;
  }

  function renderEntry() {
    setConnection("");
    const suggestedCode = (params.get("room") || "").toUpperCase();
    setScreen(`<div class="panel hero"><div class="eyebrow">حفلة محلية · كل لاعب على هاتفه</div><h1>العبوا معًا</h1><p class="lead">أنشئ غرفة أو انضم برمز من خمسة أحرف. تبقى الأسئلة والنقاش وجهًا لوجه.</p><div class="mode-grid"><button class="mode-card" id="show-create"><h3>إنشاء غرفة</h3><p>أنت المضيف وتتحكم في انتقال مراحل اللعبة.</p></button><button class="mode-card" id="show-join"><h3>الانضمام إلى غرفة</h3><p>أدخل الرمز الذي يظهر على هاتف المضيف.</p></button></div></div>`);
    document.querySelector("#show-create").addEventListener("click", renderCreate);
    document.querySelector("#show-join").addEventListener("click", () => renderJoin(suggestedCode));
    if (suggestedCode) renderJoin(suggestedCode);
  }

  function renderCreate() {
    setScreen(`<div class="panel"><div class="eyebrow">غرفة جديدة</div><h2>ابدأ كمضيف</h2><label for="host-name"><p>اسمك الظاهر</p></label><input id="host-name" class="text-input" maxlength="24" autocomplete="nickname" placeholder="اكتب اسمك"><div class="setting-row"><div><h3>التلميح</h3><p>يعرض مساعدة قصيرة مع الكلمات.</p></div><label class="switch"><input id="room-hints" type="checkbox"><span></span></label></div><div class="actions"><button class="button wide" id="create-room">إنشاء الغرفة</button><button class="button secondary wide" id="back">رجوع</button></div></div>`);
    document.querySelector("#back").addEventListener("click", renderEntry);
    document.querySelector("#create-room").addEventListener("click", async () => {
      const button = document.querySelector("#create-room");
      button.disabled = true;
      try {
        const result = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name: document.querySelector("#host-name").value, hints_enabled: document.querySelector("#room-hints").checked }) });
        saveCredentials(result);
        connect();
      } catch (error) { showToast(error.message); button.disabled = false; }
    });
  }

  function renderJoin(code = "") {
    setScreen(`<div class="panel"><div class="eyebrow">الانضمام</div><h2>أدخل بيانات الغرفة</h2><label for="room-code"><p>رمز الغرفة</p></label><input id="room-code" class="text-input" maxlength="5" autocapitalize="characters" value="${escapeHtml(code)}" placeholder="ABCDE" dir="ltr"><label for="player-name"><p class="field-gap">اسمك الظاهر</p></label><input id="player-name" class="text-input" maxlength="24" autocomplete="nickname" placeholder="اكتب اسمك"><div class="actions"><button class="button wide" id="join-room">انضمام</button><button class="button secondary wide" id="back">رجوع</button></div></div>`);
    document.querySelector("#back").addEventListener("click", renderEntry);
    document.querySelector("#room-code").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, ""); });
    document.querySelector("#join-room").addEventListener("click", async () => {
      const codeValue = document.querySelector("#room-code").value.trim().toUpperCase();
      const button = document.querySelector("#join-room");
      button.disabled = true;
      try {
        const result = await api(`/api/rooms/${encodeURIComponent(codeValue)}/join`, { method: "POST", body: JSON.stringify({ name: document.querySelector("#player-name").value }) });
        saveCredentials(result);
        connect();
      } catch (error) { showToast(error.message); button.disabled = false; }
    });
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (!credentials) return renderEntry();
    intentionalClose = false;
    setConnection("جارٍ الاتصال…", true);
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${location.host}/ws/${credentials.room_code}`);
    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      setConnection("جارٍ التحقق…", true);
      socket.send(JSON.stringify({ type: "auth", player_id: credentials.player_id, token: credentials.token }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "error") return showToast(message.message);
      const phaseChanged = !state || state.phase !== message.phase || state.round !== message.round;
      state = message;
      setConnection("متصل");
      if (phaseChanged) { secretVisible = false; selectedVote = null; }
      renderState();
    });
    socket.addEventListener("close", (event) => {
      if (intentionalClose) return;
      setConnection("غير متصل", true);
      if (event.code === 4003 || event.code === 4403 || event.code === 4404) {
        localStorage.removeItem(storageKey(credentials.room_code));
        credentials = null;
        showToast(event.code === 4003 ? "أزالك المضيف من الغرفة." : event.code === 4404 ? "الغرفة غير موجودة أو انتهت." : "تعذر استعادة جلسة اللاعب.");
        return window.setTimeout(renderEntry, 800);
      }
      const delay = Math.min(1000 * (2 ** reconnectAttempts), 10000);
      reconnectAttempts += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    });
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return showToast("الاتصال غير متاح. سنحاول مجددًا.");
    socket.send(JSON.stringify(message));
  }

  function playerList(removable = false) {
    return state.players.map(player => `<div class="room-player"><div class="player-meta"><span class="presence ${player.connected ? "online" : ""}"></span><strong>${escapeHtml(player.name)}</strong>${player.id === state.host_id ? '<span class="host-mark">المضيف</span>' : ""}</div>${removable && player.id !== state.host_id ? `<button class="danger-link remove-player" data-id="${player.id}">إزالة</button>` : `<span class="host-mark">${player.connected ? "متصل" : "منقطع"}</span>`}</div>`).join("");
  }

  function hostButton(label, action, disabled = false, secondary = false) {
    if (!state.is_host) return "";
    return `<button class="button ${secondary ? "secondary" : ""} wide host-action" data-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
  }

  function bindCommon() {
    document.querySelectorAll(".host-action").forEach(button => button.addEventListener("click", () => send({ type: "host_action", action: button.dataset.action })));
  }

  function renderState() {
    const renderer = { lobby: renderLobby, reveal: renderReveal, questions: renderQuestions, discussion: renderDiscussion, voting: renderVoting, undercover_guess: renderUndercoverGuess, scores: renderScores, finished: renderFinished }[state.phase];
    if (renderer) renderer();
  }

  function renderLobby() {
    const connected = state.players.filter(player => player.connected).length;
    const invite = `${location.origin}/party?room=${state.code}`;
    setScreen(`<div class="panel"><div class="eyebrow">غرفة الانتظار</div><h2>${state.is_host ? "شارك الرمز مع اللاعبين" : "بانتظار المضيف"}</h2><div class="room-code">${state.code}</div><div class="share-row"><input class="text-input" value="${escapeHtml(invite)}" readonly><button class="button secondary" id="copy-link">نسخ</button></div><div class="inline-stats"><span>${state.players.length} لاعب</span><span>${connected} متصل</span></div><div class="room-list">${playerList(state.is_host)}</div><div class="actions">${hostButton("بدء الجلسة", "start_game", state.players.length < 3 || connected < 3)}${state.is_host ? "" : '<span class="waiting">سيبدأ المضيف عندما يكتمل العدد</span>'}</div></div>`);
    document.querySelector("#copy-link").addEventListener("click", async () => { await navigator.clipboard.writeText(invite).catch(() => {}); showToast("تم نسخ رابط الدعوة."); });
    document.querySelectorAll(".remove-player").forEach(button => button.addEventListener("click", () => send({ type: "host_action", action: "remove_player", player_id: button.dataset.id })));
    bindCommon();
  }

  function renderReveal() {
    if (state.is_ready) {
      setScreen(`<div class="panel handoff"><div class="eyebrow">الجولة ${state.round} من 5</div><div class="handoff-icon">✓</div><h2>تم حفظ كلمتك</h2><p>أخفيناها من الشاشة. انتظر حتى ينتهي بقية اللاعبين.</p><div class="inline-stats"><span>${state.ready_count} من ${state.player_count} جاهزون</span></div><div class="actions">${hostButton("بدء الأسئلة", "start_questions", state.ready_count !== state.player_count)}</div></div>`);
      return bindCommon();
    }
    if (!secretVisible) {
      setScreen(`<div class="panel handoff"><div class="eyebrow">الجولة ${state.round} من 5</div><div class="handoff-icon">◉</div><h2>كلمتك جاهزة</h2><p>تأكد أن الشاشة لا يراها أحد غيرك.</p><div class="actions"><button class="button wide" id="show-secret">عرض كلمتي</button></div></div>`);
      return document.querySelector("#show-secret").addEventListener("click", () => { secretVisible = true; renderReveal(); });
    }
    setScreen(`<div class="panel handoff"><div class="eyebrow">كلمتك السرية</div><div class="secret-box"><div class="secret-word">${escapeHtml(state.secret.word)}</div>${state.secret.hint ? `<div class="hint">تلميح: ${escapeHtml(state.secret.hint)}</div>` : ""}</div><p>احفظها ثم أخفها قبل أن تترك هاتفك.</p><div class="actions"><button class="button wide" id="hide-ready">إخفاء وأنا جاهز</button></div></div>`);
    document.querySelector("#hide-ready").addEventListener("click", () => { secretVisible = false; screen.innerHTML = ""; send({ type: "ready" }); });
  }

  function renderQuestions() {
    const question = state.question;
    setScreen(`<div class="panel"><div class="progress"><span style="width:${Math.round(question.index / question.total * 100)}%"></span></div><div class="eyebrow">السؤال ${question.index} من ${question.total}</div><div class="assignment"><strong>${escapeHtml(question.asker)}</strong><span class="assignment-arrow">يسأل</span><strong>${escapeHtml(question.target)}</strong></div><p>اسألوا وجهًا لوجه، ثم ينتقل المضيف إلى المهمة التالية.</p><div class="actions">${hostButton(question.index === question.total ? "إنهاء الأسئلة" : "السؤال التالي", "next_question")}${state.is_host ? "" : '<span class="waiting">بانتظار المضيف</span>'}</div></div>`);
    bindCommon();
  }

  function renderDiscussion() {
    setScreen(`<div class="panel handoff"><div class="handoff-icon">…</div><div class="eyebrow">النقاش الحر</div><h2>اسألوا بحرية</h2><p>يمكنكم سؤال أي لاعب وجهًا لوجه. عندما تكون المجموعة جاهزة، يبدأ المضيف التصويت السري.</p><div class="actions">${hostButton("بدء التصويت", "start_voting")}${state.is_host ? "" : '<span class="waiting">بانتظار المضيف</span>'}</div></div>`);
    bindCommon();
  }

  function renderVoting() {
    if (state.has_voted) {
      setScreen(`<div class="panel handoff"><div class="handoff-icon">✓</div><div class="eyebrow">تصويت سري</div><h2>تم تسجيل صوتك</h2><p>لن تظهر الاختيارات حتى ينتهي الجميع.</p><div class="inline-stats"><span>${state.vote_count} من ${state.player_count} صوّتوا</span></div>${state.is_host && state.vote_count >= 2 ? `<div class="actions">${hostButton("إنهاء التصويت بالمتاح", "close_voting", false, true)}</div>` : ""}</div>`);
      return bindCommon();
    }
    const choices = state.candidates.map(player => `<button class="choice vote-choice" data-id="${player.id}">${escapeHtml(player.name)}${player.id === state.self.id ? " (أنت)" : ""}</button>`).join("");
    setScreen(`<div class="panel"><div class="eyebrow">تصويتك سري</div><h2>من تعتقد أنه المتخفي؟</h2><p>يمكنك اختيار نفسك. لا يرى الآخرون اختيارك.</p><div class="choice-grid two-columns">${choices}</div><div class="actions"><button class="button wide" id="submit-vote" disabled>تأكيد التصويت</button></div></div>`);
    document.querySelectorAll(".vote-choice").forEach(button => button.addEventListener("click", () => { selectedVote = button.dataset.id; document.querySelectorAll(".vote-choice").forEach(item => item.classList.toggle("selected", item === button)); document.querySelector("#submit-vote").disabled = false; }));
    document.querySelector("#submit-vote").addEventListener("click", () => { document.querySelector("#submit-vote").disabled = true; send({ type: "vote", target_id: selectedVote }); });
  }

  function renderUndercoverGuess() {
    const isUndercover = state.self.id === state.undercover.id;
    const options = isUndercover ? state.guess_options.map(word => `<button class="choice guess-choice" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join("") : "";
    setScreen(`<div class="panel reveal"><div class="eyebrow">انتهى التصويت</div><h2>المتخفي كان</h2><div class="reveal-name">${escapeHtml(state.undercover.name)}</div><p>كلمته كانت «${escapeHtml(state.undercover.word)}».</p>${isUndercover ? `<h3>ما كلمة الأغلبية؟</h3><div class="choice-grid">${options}</div>` : '<div class="waiting">بانتظار التخمين النهائي</div>'}${state.is_host ? `<div class="actions">${hostButton("تجاوز التخمين", "skip_guess", false, true)}</div>` : ""}</div>`);
    document.querySelectorAll(".guess-choice").forEach(button => button.addEventListener("click", () => send({ type: "guess", word: button.dataset.word }), { once: true }));
    bindCommon();
  }

  function scoreboard(final = false) {
    const best = state.scoreboard[0].score;
    return state.scoreboard.map(player => `<tr class="${final && player.score === best ? "winner-row" : ""}"><td>${escapeHtml(player.name)}</td>${final ? "" : `<td class="score-gain">${player.gain ? `+${player.gain}` : "—"}</td>`}<td>${player.score}</td></tr>`).join("");
  }

  function renderScores() {
    setScreen(`<div class="panel"><div class="eyebrow">نتيجة الجولة ${state.round}</div><h2>${state.final_guess_correct ? "تخمين صحيح للمتخفي" : "لم ينجح التخمين الأخير"}</h2><p>المتخفي: <strong>${escapeHtml(state.undercover.name)}</strong> · كلمة الأغلبية: <strong>${escapeHtml(state.majority_word)}</strong></p><table class="score-table"><thead><tr><th>اللاعب</th><th>الجولة</th><th>المجموع</th></tr></thead><tbody>${scoreboard()}</tbody></table><div class="actions">${hostButton(state.round === 5 ? "عرض النتيجة النهائية" : "الجولة التالية", "next_round")}${state.is_host ? "" : '<span class="waiting">بانتظار المضيف</span>'}</div></div>`);
    bindCommon();
  }

  function renderFinished() {
    setScreen(`<div class="panel"><div class="eyebrow">اكتملت الجولات الخمس</div><h2>الفائز: ${escapeHtml(state.winners.join(" و"))}</h2><table class="score-table"><thead><tr><th>اللاعب</th><th>المجموع</th></tr></thead><tbody>${scoreboard(true)}</tbody></table><div class="actions"><a class="button wide button-link" href="/party" id="new-room">إنشاء أو دخول غرفة جديدة</a></div></div>`);
    document.querySelector("#new-room").addEventListener("click", () => { localStorage.removeItem("undercover-current-room"); intentionalClose = true; socket?.close(); });
  }

  const requestedCode = (params.get("room") || localStorage.getItem("undercover-current-room") || "").toUpperCase();
  const stored = requestedCode ? loadCredentials(requestedCode) : null;
  document.querySelector(".brand").addEventListener("click", (event) => {
    if (!state || ["lobby", "finished"].includes(state.phase)) return;
    if (!window.confirm("هل تريد مغادرة شاشة الجلسة؟ يمكنك العودة إليها من هذا الجهاز ما دامت الغرفة نشطة.")) event.preventDefault();
  });
  if (stored) { credentials = stored; connect(); }
  else renderEntry();
}());
