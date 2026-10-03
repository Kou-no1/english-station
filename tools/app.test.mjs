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
  f.run('ui.activeView="smalltalk";ui.smallTalkTopic="can_do";ui.selectedBlocks={answer:"No, I can\'t.",detail:"I can swim well."};sendTalk(smallTalkTopics.find(t=>t.id==="can_do"))');
  assert.equal(f.run('state.smalltalk.completedTopics.length'), 0);
  f.run('ui.selectedBlocks.detail="I can\'t swim yet.";sendTalk(smallTalkTopics.find(t=>t.id==="can_do"))');
  assert.equal(f.run('state.smalltalk.completedTopics.includes("can_do")'), false);
  f.run('ui.selectedBlocks={reaction:"Really?"};sendTalk(smallTalkTopics.find(t=>t.id==="can_do"));ui.selectedBlocks={followup:"Can you play soccer?"};sendTalk(smallTalkTopics.find(t=>t.id==="can_do"))');
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

test('review intervals grow on success and a miss retains the earned star', () => {
  const f = fixture();
  f.run('markWord("num_one",true);markWord("num_one",true)');
  assert.equal(f.run('state.vocab.records.num_one.box'), 2);
  assert.equal(f.run('state.vocab.mastered.includes("num_one")'), true);
  f.run('markWord("num_one",false)');
  assert.equal(f.run('state.vocab.records.num_one.box'), 0);
  assert.equal(f.run('state.vocab.mastered.includes("num_one")'), true);
  assert.equal(f.run('dueWords(Date.now()+600001).some(word=>word.id==="num_one")'), true);
});

test('scheduler covers the category before starting a new cycle', () => {
  const f = fixture();
  f.run('state.vocab.misses.num_one=10;state.vocab.misses.num_two=10');
  const length = f.run('vocabCategories[0].words.length');
  const seen = new Set([0]);
  for (let index = 1; index < length; index++) { f.run('nextVocabWord()'); seen.add(f.run('ui.vocabIndex')); }
  assert.equal(seen.size, length);
});

test('earned rank never drops when the grade mode changes', () => {
  const f = fixture();
  f.run('state.gradeMode="3-4";state.phonics.mastered=availablePhonics().map(x=>x.id);state.vocab.mastered=availableWords().map(x=>x.id);state.smalltalk.completedTopics=availableSmallTalk().map(x=>x.id);state.gacha.collected=availableExpressions().map(x=>x.id);state.gacha.practiced=[...state.gacha.collected];updateStatus()');
  assert.equal(f.run('rankName(state.rankHighWater)'), '星間大使');
  f.click({ grade: '5-6' });
  assert.equal(f.run('rankName(state.rankHighWater)'), '星間大使');
});

test('every Small Talk topic completes a multi-turn exchange in both roles', () => {
  const f = fixture();
  const ids = f.run('smallTalkTopics.map(topic=>topic.id)');
  for (const id of ids) for (const role of ['A', 'B']) {
    f.run(`ui.activeView="smalltalk";ui.talkRole=${JSON.stringify(role)};resetTalk(${JSON.stringify(id)})`);
    for (let turn = 0; turn < 3 && !f.run('ui.talkFinished'); turn++) {
      f.run('(()=>{const topic=smallTalkTopics.find(t=>t.id===ui.smallTalkTopic);const round=talkRound(topic);for(const group of Object.keys(round.blocks))ui.selectedBlocks[group]=blockOptions(round,group)[0];sendTalk(topic)})()');
    }
    assert.equal(f.run('ui.talkFinished'), true, `${id}, ${role}`);
    assert.ok(f.run('ui.talkLog.length') >= 4);
  }
});

test('constellation positions are distinct and stay fixed across grade modes', () => {
  const f = fixture();
  const before = f.run('JSON.stringify(constellationPoints(vocabCategories.find(c=>c.id==="actions_feelings")))');
  f.run('state.gradeMode="3-4"');
  assert.equal(f.run('JSON.stringify(constellationPoints(vocabCategories.find(c=>c.id==="actions_feelings")))'), before);
  for (const category of f.run('vocabCategories.map(c=>c.id)')) {
    assert.equal(f.run(`new Set(constellationPoints(vocabCategories.find(c=>c.id===${JSON.stringify(category)})).map(p=>p.join(","))).size`), f.run(`vocabCategories.find(c=>c.id===${JSON.stringify(category)}).words.length`));
  }
});

test('drawing alone is not mastery and scene practice awards a badge', () => {
  const f = fixture();
  f.run('state.gacha.collected=["expr_hello"];ensureSceneQuiz("expr_hello")');
  assert.equal(f.run('getProgress().byDept.gacha'), 0);
  f.click({ sceneChoice: 'expr_hello' });
  f.click({ sceneChoice: 'expr_hello' });
  assert.equal(f.run('state.gacha.practiced.length'), 1);
  assert.equal(f.run('state.gacha.badges.includes("greeting")'), false);
  f.run('for(const expr of expressions.filter(e=>e.scene==="greeting")){uniquePush(state.gacha.collected,expr.id);recordExpressionPractice(expr.id)}');
  assert.equal(f.run('state.gacha.badges.includes("greeting")'), true);
});

test('export and import preserve learning records and reject unrelated files', () => {
  const f = fixture();
  f.run('markWord("num_one",true);state.gacha.collected=["expr_hello"];recordExpressionPractice("expr_hello");state.settings.rate=0.7');
  const exported = f.run('exportProgress()');
  const restored = f.run(`parseProgressImport(${JSON.stringify(exported)})`);
  assert.equal(restored.vocab.records.num_one.correct, 1);
  assert.equal(restored.settings.rate, 0.7);
  assert.deepEqual(Array.from(restored.gacha.practiced), ['expr_hello']);
  assert.throws(() => f.run(`parseProgressImport(${JSON.stringify(JSON.stringify({ app: 'other' }))})`), /別のアプリ/);
  assert.throws(() => f.run(`parseProgressImport(${JSON.stringify(JSON.stringify({ app: 'interstellar-english', formatVersion: 3 }))})`), /形式には対応/);
  assert.throws(() => f.run('parseProgressImport("[]")'));
  assert.throws(() => f.run('parseProgressImport("{}")'));
  assert.throws(() => f.run('parseProgressImport("not json")'));
});

test('progress replacement clears in-flight exercises and pending awards', () => {
  const f = fixture();
  f.run('ui.activeView="gacha";renderGacha()');
  f.click({}, ['data-gacha-draw']);
  const stale = [...f.timers.values()][0].fn;
  f.run('replaceProgress(freshState())');
  stale();
  assert.equal(f.run('state.gacha.collected.length'), 0);
  assert.equal(f.run('ui.talkTurn'), 0);
  assert.equal(f.run('ui.vocabQuiz'), null);
});

test('course content covers the promised scope and has stable unique identifiers', () => {
  const f = fixture();
  assert.equal(f.run('vocabCategories.length'), 10);
  assert.equal(f.run('vocabCategories.flatMap(c=>c.words).length'), 100);
  assert.equal(f.run('phonicsItems.filter(p=>p.level===1).length'), 26);
  assert.equal(f.run('phonicsItems.length'), 44);
  assert.equal(f.run('smallTalkTopics.length'), 9);
  assert.equal(f.run('expressions.length'), 24);
  assert.equal(f.run('smallTalkTopics.every(topic=>talkPractice[topic.id])'), true);
  for (const data of ['vocabCategories.flatMap(c=>c.words)', 'phonicsItems', 'smallTalkTopics', 'expressions']) {
    assert.equal(f.run(`new Set((${data}).map(item=>item.id)).size`), f.run(`(${data}).length`));
  }
  assert.equal(f.run('availableWords().every(word=>word.unit&&word.tags.length&&word.icon)'), true);
});

test('all phonics questions offer four distinguishable choices', () => {
  const f = fixture();
  f.run('ui.activeView="phonics"');
  for (const id of f.run('phonicsItems.map(item=>item.id)')) {
    f.run(`(()=>{const item=phonicsItems.find(p=>p.id===${JSON.stringify(id)});createPhonicsQuiz(item,phonicsItems.filter(p=>p.level===item.level))})()`);
    assert.equal(f.run('ui.phonicsQuiz.choices.length'), 4, id);
    assert.equal(f.run('new Set(ui.phonicsQuiz.choices.map(c=>c.pattern)).size'), 4, id);
    assert.equal(f.run('new Set(ui.phonicsQuiz.choices.map(c=>c.ipa)).size'), 4, id);
  }
});

test('legacy stars and earned badges survive course expansion', () => {
  const f = fixture(JSON.stringify({ gradeMode: '3-4', rankHighWater: 100, vocab: { mastered: ['animal_dog', 'animal_cat'], categoriesComplete: ['animals'] }, gacha: { collected: ['expr_hello'], practiced: ['expr_hello'], badges: ['greeting'] } }));
  assert.equal(f.run('state.vocab.mastered.includes("animal_dog")'), true);
  assert.equal(f.run('state.vocab.badges.includes("animals")'), true);
  assert.equal(f.run('state.gacha.badges.includes("greeting")'), true);
  assert.equal(f.run('state.rankHighWater'), 100);
});
