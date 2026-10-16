(function () {
  "use strict";

  const screen = document.querySelector("#screen");
  const roundIndicator = document.querySelector("#round-indicator");
  const toast = document.querySelector("#toast");
  let game;
  let activeGame = false;

  let setupNames = ["", "", ""];
  let setupHintsEnabled = false;
  let revealIndex = 0;
  let assignmentIndex = 0;
  let voterIndex = 0;
  let selectedVote = null;
  let guessOptions = [];
  let privatePhase = null;

  const escapeHtml = (value) => String(value)
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
    window.setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function updateRoundIndicator() {
    const active = game.roundNumber > 0;
    roundIndicator.hidden = !active;
    roundIndicator.textContent = active ? `الجولة ${game.roundNumber} من 5` : "";
  }

  function progress(current, total) {
    return `<div class="progress" aria-label="التقدم"><span style="width:${Math.round((current / total) * 100)}%"></span></div>`;
  }

  function renderHome() {
    game.reset();
    activeGame = false;
    privatePhase = null;
    updateRoundIndicator();
    setScreen(`
      <div class="panel hero">
        <div class="eyebrow">لعبة حفلات عربية</div>
        <h1>من هو المتخفي؟</h1>
        <p class="lead">لكم كلمات متقاربة، وبينكم لاعب واحد يحمل كلمة مختلفة. اختروا طريقة اللعب المناسبة للمجموعة.</p>
        <div class="mode-grid">
          <button class="mode-card" id="start-setup"><h3>جهاز واحد</h3><p>مرّروا هاتفًا واحدًا بين 3–12 لاعبًا.</p></button>
          <a class="mode-card" href="/party"><h3>حفلة محلية</h3><p>كل لاعب يستخدم هاتفه داخل الغرفة نفسها.</p></a>
        </div>
        <p class="note">5 جولات · من 3 إلى 12 لاعبًا · بلا حسابات</p>
      </div>`);
    document.querySelector("#start-setup").addEventListener("click", renderSetup);
  }

  function renderSetup() {
    updateRoundIndicator();
    const rows = setupNames.map((name, index) => `
      <div class="player-row">
        <span class="player-number">${index + 1}</span>
        <input class="text-input player-input" data-index="${index}" maxlength="24" value="${escapeHtml(name)}" placeholder="اسم اللاعب ${index + 1}" autocomplete="off">
        <button class="icon-button remove-player" data-index="${index}" aria-label="حذف اللاعب" ${setupNames.length <= 3 ? "disabled" : ""}>×</button>
      </div>`).join("");
    setScreen(`
      <div class="panel">
        <div class="setup-head"><div><div class="eyebrow">إعداد الجلسة</div><h2>من سيلعب؟</h2></div><span class="counter">${setupNames.length} / 12</span></div>
        <p>أدخل أسماء مختلفة، ثم مرّر الجهاز بين اللاعبين عند بدء الجولة.</p>
        <div class="player-list">${rows}</div>
        <div class="actions"><button class="button secondary" id="add-player" ${setupNames.length >= 12 ? "disabled" : ""}>إضافة لاعب</button></div>
        <div class="setting-row">
          <div><h3>التلميح</h3><p>يعرض كلمة مساعدة غير مباشرة مع الكلمة السرية.</p></div>
          <label class="switch"><input id="hints" type="checkbox" ${setupHintsEnabled ? "checked" : ""}><span></span></label>
        </div>
        <div class="actions"><button class="button wide" id="begin-session">بدء الجولة الأولى</button></div>
      </div>`);

    document.querySelectorAll(".player-input").forEach((input) => input.addEventListener("input", (event) => {
      setupNames[Number(event.target.dataset.index)] = event.target.value;
    }));
    document.querySelector("#hints").addEventListener("change", (event) => {
      setupHintsEnabled = event.target.checked;
    });
    document.querySelectorAll(".remove-player").forEach((button) => button.addEventListener("click", () => {
      setupNames.splice(Number(button.dataset.index), 1);
      renderSetup();
    }));
    document.querySelector("#add-player").addEventListener("click", () => {
      if (setupNames.length < 12) setupNames.push("");
      renderSetup();
      document.querySelectorAll(".player-input")[setupNames.length - 1].focus();
    });
    document.querySelector("#begin-session").addEventListener("click", () => {
      try {
        game.startSession(setupNames, setupHintsEnabled);
        activeGame = true;
        prepareRound();
      } catch (error) { showToast(error.message); }
    });
  }

  function prepareRound() {
    revealIndex = 0;
    assignmentIndex = 0;
    voterIndex = 0;
    selectedVote = null;
    guessOptions = [];
    updateRoundIndicator();
    renderRevealHandoff();
  }

  function renderRevealHandoff() {
    privatePhase = "reveal";
    const player = game.round.revealOrder[revealIndex];
    setScreen(`
      <div class="panel handoff">
        ${progress(revealIndex, game.players.length)}
        <div class="handoff-icon" aria-hidden="true">↗</div>
        <div class="eyebrow">مرّر الجهاز بأمان</div>
        <h2>سلّم الجهاز إلى <span class="player-name">${escapeHtml(player.name)}</span></h2>
        <p>تأكد أن لا أحد غيرك يرى الشاشة، ثم اعرض كلمتك.</p>
        <div class="actions"><button class="button wide" id="show-secret">عرض الكلمة</button></div>
      </div>`);
    document.querySelector("#show-secret").addEventListener("click", renderSecret);
  }

  function renderSecret() {
    const player = game.round.revealOrder[revealIndex];
    const secret = game.secretFor(player);
    setScreen(`
      <div class="panel handoff">
        <div class="eyebrow">كلمتك السرية</div>
        <h2>${escapeHtml(player.name)}</h2>
        <div class="secret-box"><div class="secret-word">${escapeHtml(secret.word)}</div>${game.hintsEnabled ? `<div class="hint">تلميح: ${escapeHtml(secret.hint)}</div>` : ""}</div>
        <p>احفظ الكلمة ولا تكشفها للآخرين.</p>
        <div class="actions"><button class="button wide" id="hide-secret">إخفاء والمتابعة</button></div>
      </div>`);
    document.querySelector("#hide-secret").addEventListener("click", () => {
      screen.innerHTML = "";
      revealIndex += 1;
      if (revealIndex < game.players.length) renderRevealHandoff();
      else renderQuestionIntro();
    });
  }

  function renderQuestionIntro() {
    privatePhase = null;
    setScreen(`
      <div class="panel">
        <div class="eyebrow">مرحلة الأسئلة المنظمة</div>
        <h2>كل لاعب يسأل مرة واحدة</h2>
        <p>حددت اللعبة ترتيبًا عشوائيًا. اطرح سؤالًا يساعدك على فهم كلمة الطرف الآخر من دون أن تكشف كلمتك.</p>
        <div class="actions"><button class="button wide" id="begin-questions">عرض أول مهمة</button></div>
      </div>`);
    document.querySelector("#begin-questions").addEventListener("click", renderAssignment);
  }

  function renderAssignment() {
    const item = game.round.assignments[assignmentIndex];
    setScreen(`
      <div class="panel">
        ${progress(assignmentIndex + 1, game.players.length)}
        <div class="eyebrow">السؤال ${assignmentIndex + 1} من ${game.players.length}</div>
        <div class="assignment"><strong>${escapeHtml(item.asker.name)}</strong><span class="assignment-arrow">يسأل</span><strong>${escapeHtml(item.target.name)}</strong></div>
        <p>اسأل سؤالًا واحدًا، وانتظر الإجابة، ثم انتقل إلى المهمة التالية.</p>
        <div class="actions"><button class="button wide" id="question-done">تم السؤال</button></div>
      </div>`);
    document.querySelector("#question-done").addEventListener("click", () => {
      assignmentIndex += 1;
      if (assignmentIndex < game.round.assignments.length) renderAssignment();
      else renderFreeDiscussion();
    });
  }

  function renderFreeDiscussion() {
    setScreen(`
      <div class="panel handoff">
        <div class="handoff-icon" aria-hidden="true">…</div>
        <div class="eyebrow">النقاش الحر</div>
        <h2>الآن اسألوا بحرية</h2>
        <p>يمكن لأي لاعب سؤال أي لاعب آخر وجهًا لوجه، وبأي عدد من الأسئلة. عندما تصبحون جاهزين، ابدأوا التصويت السري.</p>
        <div class="actions"><button class="button wide" id="begin-voting">بدء التصويت</button></div>
      </div>`);
    document.querySelector("#begin-voting").addEventListener("click", renderVoteHandoff);
  }

  function renderVoteHandoff() {
    privatePhase = "vote";
    selectedVote = null;
    const voter = game.round.votingOrder[voterIndex];
    setScreen(`
      <div class="panel handoff">
        ${progress(voterIndex, game.players.length)}
        <div class="handoff-icon" aria-hidden="true">✓</div>
        <div class="eyebrow">تصويت سري</div>
        <h2>سلّم الجهاز إلى <span class="player-name">${escapeHtml(voter.name)}</span></h2>
        <p>لا تترك اختيار اللاعب السابق ظاهرًا.</p>
        <div class="actions"><button class="button wide" id="open-ballot">فتح ورقة التصويت</button></div>
      </div>`);
    document.querySelector("#open-ballot").addEventListener("click", renderBallot);
  }

  function renderBallot() {
    const voter = game.round.votingOrder[voterIndex];
    const choices = game.players.map((player) => `<button class="choice" data-player-id="${player.id}">${escapeHtml(player.name)}</button>`).join("");
    setScreen(`
      <div class="panel">
        <div class="eyebrow">تصويت ${escapeHtml(voter.name)}</div>
        <h2>من تعتقد أنه المتخفي؟</h2>
        <p>اختر لاعبًا واحدًا. يمكنك اختيار نفسك.</p>
        <div class="choice-grid two-columns">${choices}</div>
        <div class="actions"><button class="button wide" id="confirm-vote" disabled>تأكيد التصويت</button></div>
      </div>`);
    document.querySelectorAll(".choice").forEach((choice) => choice.addEventListener("click", () => {
      selectedVote = Number(choice.dataset.playerId);
      document.querySelectorAll(".choice").forEach((item) => item.classList.toggle("selected", item === choice));
      document.querySelector("#confirm-vote").disabled = false;
    }));
    document.querySelector("#confirm-vote").addEventListener("click", () => {
      game.recordVote(voter.id, selectedVote);
      screen.innerHTML = "";
      selectedVote = null;
      voterIndex += 1;
      if (voterIndex < game.players.length) renderVoteHandoff();
      else renderUndercoverReveal();
    });
  }

  function renderUndercoverReveal() {
    privatePhase = null;
    const undercover = game.round.undercover;
    setScreen(`
      <div class="panel reveal">
        <div class="eyebrow">انتهى التصويت</div>
        <h2>المتخفي كان</h2>
        <div class="reveal-name">${escapeHtml(undercover.name)}</div>
        <p>كلمته كانت «${escapeHtml(game.round.undercoverSecret.word)}». لديه الآن فرصة أخيرة لمعرفة كلمة الأغلبية.</p>
        <div class="actions"><button class="button wide" id="handoff-guess">مرّر الجهاز إلى ${escapeHtml(undercover.name)}</button></div>
      </div>`);
    document.querySelector("#handoff-guess").addEventListener("click", renderGuessHandoff);
  }

  function renderGuessHandoff() {
    privatePhase = "guess";
    setScreen(`
      <div class="panel handoff">
        <div class="handoff-icon" aria-hidden="true">؟</div>
        <div class="eyebrow">التخمين الأخير</div>
        <h2>سلّم الجهاز إلى <span class="player-name">${escapeHtml(game.round.undercover.name)}</span></h2>
        <p>اختر كلمة الأغلبية لتحصل على نقطة إضافية.</p>
        <div class="actions"><button class="button wide" id="open-guess">عرض الخيارات</button></div>
      </div>`);
    document.querySelector("#open-guess").addEventListener("click", renderFinalGuess);
  }

  function renderFinalGuess() {
    if (!guessOptions.length) guessOptions = game.finalGuessOptions();
    const choices = guessOptions.map((word) => `<button class="choice guess-choice" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join("");
    setScreen(`
      <div class="panel">
        <div class="eyebrow">فرصة واحدة</div>
        <h2>ما كلمة الأغلبية؟</h2>
        <div class="choice-grid">${choices}</div>
      </div>`);
    document.querySelectorAll(".guess-choice").forEach((choice) => choice.addEventListener("click", () => {
      game.recordFinalGuess(choice.dataset.word);
      screen.innerHTML = "";
      renderRoundScore();
    }, { once: true }));
  }

  function scoreRows(final = false) {
    const scores = game.sortedScores();
    const topScore = scores[0].score;
    return scores.map((player) => {
      const gain = game.round.gains.get(player.id);
      const winnerClass = final && player.score === topScore ? "winner-row" : "";
      return `<tr class="${winnerClass}"><td>${escapeHtml(player.name)}</td>${final ? "" : `<td class="score-gain">${gain ? `+${gain}` : "—"}</td>`}<td>${player.score}</td></tr>`;
    }).join("");
  }

  function renderRoundScore() {
    privatePhase = null;
    const correct = game.round.finalGuess.correct;
    setScreen(`
      <div class="panel">
        <div class="eyebrow">نتيجة الجولة ${game.roundNumber}</div>
        <h2>${correct ? "تخمين صحيح للمتخفي" : "لم ينجح التخمين الأخير"}</h2>
        <p>المتخفي: <strong>${escapeHtml(game.round.undercover.name)}</strong> · كلمة الأغلبية: <strong>${escapeHtml(game.round.majoritySecret.word)}</strong></p>
        <table class="score-table"><thead><tr><th>اللاعب</th><th>هذه الجولة</th><th>المجموع</th></tr></thead><tbody>${scoreRows()}</tbody></table>
        <div class="actions"><button class="button wide" id="continue">${game.isLastRound ? "عرض النتيجة النهائية" : "الجولة التالية"}</button></div>
      </div>`);
    document.querySelector("#continue").addEventListener("click", () => {
      if (game.isLastRound) renderFinalScore();
      else { game.startRound(); prepareRound(); }
    });
  }

  function renderFinalScore() {
    activeGame = false;
    updateRoundIndicator();
    const topScore = game.sortedScores()[0].score;
    const winners = game.sortedScores().filter((player) => player.score === topScore).map((player) => player.name).join(" و");
    setScreen(`
      <div class="panel">
        <div class="eyebrow">اكتملت الجولات الخمس</div>
        <h2>الفائز: ${escapeHtml(winners)}</h2>
        <p>جلسة رائعة! هذه هي النتيجة النهائية.</p>
        <table class="score-table"><thead><tr><th>اللاعب</th><th>المجموع</th></tr></thead><tbody>${scoreRows(true)}</tbody></table>
        <div class="actions"><button class="button wide" id="new-session">جلسة جديدة بالكامل</button></div>
      </div>`);
    document.querySelector("#new-session").addEventListener("click", () => {
      setupNames = ["", "", ""];
      setupHintsEnabled = false;
      renderSetup();
    });
  }

  // The app is a single page; replacing private DOM and intercepting Back avoids restoring revealed content.
  history.replaceState({ undercover: true }, "", location.href);
  history.pushState({ undercover: true }, "", location.href);
  window.addEventListener("popstate", () => {
    history.pushState({ undercover: true }, "", location.href);
    selectedVote = null;
    if (privatePhase === "reveal") renderRevealHandoff();
    else if (privatePhase === "vote") renderVoteHandoff();
    else if (privatePhase === "guess") renderGuessHandoff();
  });

  document.querySelector(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    if (activeGame && !window.confirm("هل تريد مغادرة الجلسة الحالية؟ ستفقد تقدمها.")) return;
    setupNames = ["", "", ""];
    setupHintsEnabled = false;
    renderHome();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!activeGame) return;
    event.preventDefault();
    event.returnValue = "";
  });

  async function boot() {
    try {
      const response = await fetch("/undercover-assets/data/word_pairs.json");
      if (!response.ok) throw new Error("تعذر تحميل مكتبة الكلمات.");
      game = new window.UndercoverGame(await response.json());
      renderHome();
    } catch (error) {
      setScreen(`<div class="panel"><h2>تعذر تشغيل اللعبة</h2><p>${escapeHtml(error.message)}</p><div class="actions"><button class="button" onclick="location.reload()">إعادة المحاولة</button></div></div>`);
    }
  }

  boot();
}());
