import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function fixture(saved = null, denied = false) {
  const nodes = new Map();
  const listeners = {};
  const timers = new Map();
  const utterances = [];
  let nextTimer = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, querySelector: selector => node(selector), focus() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    console, Date, Math, Set, Map, JSON, Object, Array, Number, String,
    Audio: class { play() { return Promise.resolve(); } pause() {} },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: { getItem: () => saved, setItem: (_, value) => { if (denied) throw new Error('QuotaExceededError'); saved = value; } },
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener: (type, fn) => { listeners[type] = fn; } },
    window: {
      speechSynthesis: { cancel() {}, getVoices: () => [], speak: utterance => utterances.push(utterance) },
      setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
      clearTimeout: id => timers.delete(id), confirm: () => true
    }
  });
  vm.runInContext(source, context);
  return {
    run: code => vm.runInContext(code, context), node, timers, utterances,
    click(dataset = {}, attributes = []) {
      listeners.click({ target: { closest: () => ({ dataset, hasAttribute: name => attributes.includes(name) }) } });
    }
  };
}

test('invalid storage is normalized and unavailable storage does not interrupt learning', () => {
  const f = fixture(JSON.stringify({ gradeMode: 'bad', phonics: { mastered: null }, vocab: { streaks: { num_one: '2' } } }));
  assert.equal(f.run('state.gradeMode'), '5-6');
  assert.equal(f.run('state.phonics.mastered.length'), 0);
  assert.equal(f.run('state.vocab.streaks.num_one'), undefined);
  const blocked = fixture(null, true);
  assert.doesNotThrow(() => blocked.run('markWord("num_one", true)'));
  assert.match(blocked.run('storageIssue'), /記録できません/);
});

test('one quiz answer cannot be counted twice', () => {
  const f = fixture();
  f.run('ui.activeView="vocab";ui.vocabMode="quiz";renderVocab()');
  const answer = f.run('ui.vocabQuiz.answer');
  f.click({ vocabChoice: answer });
  f.click({ vocabChoice: answer });
  assert.equal(f.run(`state.vocab.streaks[${JSON.stringify(answer)}]`), 1);
  assert.equal(f.run('state.vocab.mastered.length'), 0);
});

test('flash self-check needs a reveal and records only one attempt', () => {
  const f = fixture();
  f.click({}, ['data-vocab-known']);
  assert.equal(f.run('state.vocab.streaks.num_one'), undefined);
  f.click({}, ['data-vocab-reveal']);
  f.click({}, ['data-vocab-known']);
  f.click({}, ['data-vocab-known']);
  assert.equal(f.run('state.vocab.streaks.num_one'), 1);
});

test('two missed words cannot trap vocabulary practice', () => {
  const f = fixture();
  f.run('state.vocab.misses.num_one=2;state.vocab.misses.num_two=2');
  const seen = new Set();
  for (let index = 0; index < 30; index++) { f.run('nextVocabWord()'); seen.add(f.run('ui.vocabIndex')); }
  assert.ok(seen.size > 2);
});

test('phonics quizzes have unique labels and sounds and do not reveal their answer', () => {
  const f = fixture();
  f.run('ui.activeView="phonics";ui.phonicsLevel=3;renderPhonics()');
  const count = f.run('ui.phonicsQuiz.choices.length');
  assert.equal(f.run('new Set(ui.phonicsQuiz.choices.map(c=>c.pattern)).size'), count);
  assert.equal(f.run('new Set(ui.phonicsQuiz.choices.map(c=>c.ipa)).size'), count);
  assert.match(f.node('view-phonics').innerHTML, /signal-pattern[^>]*>\?<\/div>/);
});

test('invalid replies are rejected and a valid reply stays visible', () => {
  const f = fixture();
  f.run('ui.activeView="smalltalk";ui.selectedBlocks={answer:"No, I can\'t.",detail:"I can swim well."};sendTalk(smallTalkTopics.find(t=>t.id==="can_do"))');
  assert.equal(f.run('state.smalltalk.completedTopics.length'), 0);
  f.run('ui.selectedBlocks.detail="I can\'t swim yet.";sendTalk(smallTalkTopics.find(t=>t.id==="can_do"))');
  assert.equal(f.run('state.smalltalk.completedTopics.includes("can_do")'), true);
  assert.match(f.run('ui.feedback["smalltalk:main"].message'), /成功/);
  assert.equal(f.timers.size, 0);
});

test('dialogue waits for completion and stopping prevents later utterances', async () => {
  const f = fixture();
  const playing = f.run('playDialogue(smallTalkTopics[0])');
  assert.equal(f.utterances.length, 1);
  f.utterances[0].onend();
  await Promise.resolve();
  assert.equal(f.utterances.length, 2);
  f.run('stopAudio()');
  await playing;
  assert.equal(f.timers.size, 0);
});

test('warp is single flight and reset cancels the pending award', () => {
  const f = fixture();
  f.run('ui.activeView="gacha";renderGacha()');
  f.click({}, ['data-gacha-draw']);
  f.click({}, ['data-gacha-draw']);
  assert.equal(f.timers.size, 1);
  const stale = [...f.timers.values()][0].fn;
  f.run('resetAll()');
  stale();
  assert.equal(f.run('state.gacha.collected.length'), 0);
  assert.equal(f.run('ui.gachaSpinning'), false);
});

test('grade restriction also applies to the last discovered card', () => {
  const f = fixture();
  f.run('ui.activeView="gacha";ui.gachaLast=expressions.find(e=>e.rarity==="super")');
  f.click({ grade: '3-4' });
  assert.doesNotMatch(f.node('view-gacha').innerHTML, /looking forward/);
});

test('letter tiles cannot be reused and stay in the same positions', () => {
  const f = fixture();
  f.run('ui.activeView="phonics";ui.phonicsLevel=3;ui.phonicsMode="practice";renderPhonics()');
  const letters = f.run('ui.buildTiles.join("")');
  const letter = f.run('ui.buildTiles[0]');
  f.click({ letter, tileIndex: '0' });
  f.click({ letter, tileIndex: '0' });
  assert.equal(f.run('ui.buildAnswer'), letter);
  assert.equal(f.run('ui.buildTiles.join("")'), letters);
});

test('all phonics items have nonempty embedded RIFF audio', () => {
  const f = fixture();
  const ids = f.run('phonicsItems.map(item=>item.id)');
  for (const id of ids) {
    const bytes = Buffer.from(f.run(`phonicsAudio[${JSON.stringify(id)}]`), 'base64');
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.ok(bytes.length > 1000);
  }
});
