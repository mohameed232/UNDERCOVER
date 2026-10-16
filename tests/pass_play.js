const assert = require('node:assert/strict');
global.window = global;
require('../static/js/game.js');
const pairs = require('../static/data/word_pairs.json');

for (let count = 3; count <= 12; count += 1) {
  for (let session = 0; session < 20; session += 1) {
    const game = new UndercoverGame(pairs);
    const names = Array.from({ length: count }, (_, index) => `لاعب ${index + 1}`);
    game.startSession(names, session % 2 === 0);
    const used = new Set();
    for (let round = 0; round < 5; round += 1) {
      const current = game.round;
      assert.equal(current.assignments.length, count);
      assert.equal(new Set(current.assignments.map(item => item.asker.id)).size, count);
      assert.ok(current.assignments.every(item => item.asker.id !== item.target.id));
      assert.ok(!used.has(current.pair.id));
      used.add(current.pair.id);
      for (const voter of current.votingOrder) game.recordVote(voter.id, current.undercover.id);
      game.recordFinalGuess(current.majoritySecret.word);
      if (round < 4) game.startRound();
    }
    assert.equal(used.size, 5);
    assert.equal(game.roundNumber, 5);
  }
}
console.log('Pass & Play: 200 complete sessions passed');
