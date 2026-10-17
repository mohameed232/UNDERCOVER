(function () {
  "use strict";

  const TOTAL_ROUNDS = 5;

  function randomInt(maximum) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error("نطاق عشوائي غير صالح.");
    if (!globalThis.crypto?.getRandomValues) throw new Error("المتصفح لا يدعم التوزيع العشوائي الآمن.");
    const range = 0x100000000;
    const limit = Math.floor(range / maximum) * maximum;
    const values = new Uint32Array(1);
    do { globalThis.crypto.getRandomValues(values); } while (values[0] >= limit);
    return values[0] % maximum;
  }

  function shuffled(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const randomIndex = randomInt(index + 1);
      [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy;
  }

  function makeAssignments(players) {
    const order = shuffled(players);
    return order.map((asker, index) => ({
      asker,
      target: order[(index + 1) % order.length]
    }));
  }

  class UndercoverGame {
    constructor(wordPairs) {
      this.wordPairs = wordPairs;
      this.reset();
    }

    reset() {
      this.players = [];
      this.hintsEnabled = false;
      this.roundNumber = 0;
      this.usedPairIds = new Set();
      this.round = null;
    }

    startSession(names, hintsEnabled) {
      const cleanNames = names.map((name) => name.trim());
      if (cleanNames.length < 3 || cleanNames.length > 12) throw new Error("يجب أن يكون عدد اللاعبين بين 3 و12.");
      if (cleanNames.some((name) => !name)) throw new Error("أدخل اسمًا لكل لاعب.");
      if (new Set(cleanNames).size !== cleanNames.length) throw new Error("استخدم أسماء مختلفة للاعبين.");

      this.players = cleanNames.map((name, id) => ({ id, name, score: 0 }));
      this.hintsEnabled = Boolean(hintsEnabled);
      this.roundNumber = 0;
      this.usedPairIds.clear();
      this.startRound();
    }

    startRound() {
      if (this.roundNumber >= TOTAL_ROUNDS) throw new Error("انتهت الجلسة.");
      const availablePairs = this.wordPairs.filter((pair) => !this.usedPairIds.has(pair.id));
      const pair = availablePairs[randomInt(availablePairs.length)];
      this.usedPairIds.add(pair.id);
      this.roundNumber += 1;

      const previousUndercoverId = this.round?.undercover.id;
      const eligiblePlayers = this.players.filter(player => player.id !== previousUndercoverId);
      const undercover = eligiblePlayers[randomInt(eligiblePlayers.length)];
      const majorityUsesA = randomInt(2) === 0;
      const majoritySecret = majorityUsesA ? pair.a : pair.b;
      const undercoverSecret = majorityUsesA ? pair.b : pair.a;
      const revealOrder = shuffled(this.players);

      this.round = {
        pair,
        undercover,
        majoritySecret,
        undercoverSecret,
        revealOrder,
        assignments: makeAssignments(this.players),
        votingOrder: shuffled(this.players),
        votes: new Map(),
        gains: new Map(this.players.map((player) => [player.id, 0])),
        finalGuess: null
      };
    }

    secretFor(player) {
      return player.id === this.round.undercover.id ? this.round.undercoverSecret : this.round.majoritySecret;
    }

    recordVote(voterId, targetId) {
      if (this.round.votes.has(voterId)) throw new Error("تم تسجيل تصويت هذا اللاعب.");
      if (!this.players.some((player) => player.id === targetId)) throw new Error("اختيار غير صالح.");
      this.round.votes.set(voterId, targetId);
      if (targetId === this.round.undercover.id) {
        const voter = this.players.find((player) => player.id === voterId);
        voter.score += 1;
        this.round.gains.set(voterId, this.round.gains.get(voterId) + 1);
      }
    }

    finalGuessOptions() {
      const currentWords = new Set([this.round.pair.a.word, this.round.pair.b.word]);
      let candidates = this.wordPairs
        .filter((pair) => pair.category === this.round.pair.category && pair.id !== this.round.pair.id)
        .flatMap((pair) => [pair.a.word, pair.b.word])
        .filter((word) => !currentWords.has(word));
      if (candidates.length < 4) {
        candidates = candidates.concat(this.wordPairs.flatMap((pair) => [pair.a.word, pair.b.word]));
      }
      const incorrect = shuffled([...new Set(candidates.filter((word) => !currentWords.has(word)))]).slice(0, 4);
      return shuffled([this.round.majoritySecret.word, ...incorrect]);
    }

    recordFinalGuess(word) {
      if (this.round.finalGuess !== null) throw new Error("تم تسجيل التخمين النهائي.");
      const correct = word === this.round.majoritySecret.word;
      this.round.finalGuess = { word, correct };
      if (correct) {
        this.round.undercover.score += 1;
        const id = this.round.undercover.id;
        this.round.gains.set(id, this.round.gains.get(id) + 1);
      }
      return correct;
    }

    sortedScores() {
      return [...this.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ar"));
    }

    get isLastRound() { return this.roundNumber === TOTAL_ROUNDS; }
  }

  window.UndercoverGame = UndercoverGame;
  window.UndercoverGameUtils = { randomInt, shuffled, makeAssignments, TOTAL_ROUNDS };
}());
