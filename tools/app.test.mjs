import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function fixture(saved = null, denied = false, workspaceSaved = null) {
  const nodes = new Map();
  const listeners = {};
  const timers = new Map();
  const utterances = [];
  let nextTimer = 0;
  const storage = new Map();
  if (saved !== null) storage.set('interstellar_english_progress_v1', saved);
  if (workspaceSaved !== null) storage.set('interstellar_english_workspace_v1', workspaceSaved);
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', hidden: false, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, querySelector: selector => node(selector), focus() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    console, Date, Math, Set, Map, JSON, Object, Array, Number, String, URL, URLSearchParams,
    Audio: class { play() { return Promise.resolve(); } pause() {} },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (denied) throw new Error('QuotaExceededError'); storage.set(key, value); } },
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener: (type, fn) => { listeners[type] = fn; } },
    window: {
      speechSynthesis: { cancel() {}, getVoices: () => [], speak: utterance => utterances.push(utterance) },
      setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
      clearTimeout: id => timers.delete(id), confirm: () => true
    }
  });
  vm.runInContext(source, context);
  return {
    run: code => vm.runInContext(code, context), node, timers, utterances, storage,
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
  assert.throws(() => f.run(`parseProgressImport(${JSON.stringify(JSON.stringify({ app: 'interstellar-english', formatVersion: 4 }))})`), /形式には対応/);
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
  assert.equal(f.run('vocabCategories.length'), 20);
  assert.equal(f.run('vocabCategories.flatMap(c=>c.words).length'), 200);
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

test('retention needs correct answers on different days and errors keep earned rewards', () => {
  const f = fixture();
  f.run('const yesterday=Date.now()-86400000;recordRetention("phonics","ph_a",true,yesterday);recordRetention("phonics","ph_a",true,yesterday);uniquePush(state.phonics.mastered,"ph_a")');
  assert.equal(f.run('state.retention["phonics:ph_a"].box'), 1);
  assert.equal(f.run('state.retention["phonics:ph_a"].settled'), false);
  f.run('recordRetention("phonics","ph_a",true)');
  assert.equal(f.run('state.retention["phonics:ph_a"].settled'), true);
  f.run('recordRetention("phonics","ph_a",false)');
  assert.equal(f.run('state.retention["phonics:ph_a"].settled'), false);
  assert.equal(f.run('state.phonics.mastered.includes("ph_a")'), true);
  assert.equal(f.run('state.retention["phonics:ph_a"].dueAt>Date.now()'), true);
});

test('unified review includes all four departments and cannot double count an answer', () => {
  const f = fixture();
  f.run('state.vocab.mastered=["num_one"];state.phonics.mastered=["ph_a"];state.gacha.collected=["expr_hello"];state.gacha.practiced=["expr_hello"];state.smalltalk.completedTopics=["likes"];startUnifiedReview()');
  assert.equal(f.run('new Set(ui.unifiedReview.queue.map(item=>item.kind)).size'), 4);
  f.run('renderReview();const entry=ui.unifiedReview.queue[0];answerReview(entry.id);answerReview(entry.id)');
  assert.equal(f.run('state.retention["vocab:num_one"].attempts'), 1);
  assert.equal(f.run('ui.unifiedReview.correct'), 1);
});

test('missions finish all four steps and award completion once', () => {
  const f = fixture();
  f.run('startMission()');
  for (let turn = 0; turn < 4; turn++) {
    f.run('renderMission();ui.mission.checked.talk=true;answerMission(ui.mission.steps[ui.mission.index].id);nextMission()');
  }
  f.run('nextMission()');
  assert.equal(f.run('state.missions.completed'), 1);
  assert.equal(f.run('ui.mission.correct'), 4);
  assert.equal(f.run('new Set(Object.keys(state.retention).map(key=>key.split(":")[0])).size'), 4);
});

test('pair work uses personal facts and requires a complete reflection', () => {
  const f = fixture();
  f.run('state.personal.name="Ren";state.personal.like="curry";state.personal.wake="06:15";startPair();ui.pair.topic="likes";completePair()');
  assert.equal(f.run('personalAnswer("likes")'), 'I like curry.');
  assert.equal(f.run('personalAnswer("daily_routine")'), 'I get up at 6:15.');
  assert.equal(f.run('state.pairSessions.likes'), undefined);
  f.run('ui.pair.stage=4;ui.pair.checked={0:true,1:true,2:true};completePair();completePair()');
  assert.equal(f.run('state.pairSessions.likes'), 1);
  assert.equal(f.run('state.smalltalk.completedTopics.includes("likes")'), true);
  assert.equal(f.run('normalizeState({personal:{name:"<script>",wake:"99:00",like:"<svg>"}}).personal.name'), 'Sora');
});

test('profiles isolate records, cancel pending awards, and survive reload', () => {
  const f = fixture();
  const initial = f.run('workspace.activeId');
  f.run('markWord("num_one",true);markWord("num_one",true);ui.activeView="gacha";renderGacha()');
  f.click({}, ['data-gacha-draw']);
  const stale = [...f.timers.values()][0].fn;
  const second = f.run('addProfile("通信士2")');
  f.run(`switchProfile(${JSON.stringify(second)})`);
  stale();
  assert.equal(f.run('state.vocab.mastered.length'), 0);
  assert.equal(f.run('state.gacha.collected.length'), 0);
  f.run('markWord("animal_dog",true);markWord("animal_dog",true)');
  f.run(`switchProfile(${JSON.stringify(initial)})`);
  assert.equal(f.run('state.vocab.mastered.includes("num_one")'), true);
  assert.equal(f.run('state.vocab.mastered.includes("animal_dog")'), false);
  const reloaded = fixture(null, false, f.storage.get('interstellar_english_workspace_v1'));
  assert.equal(reloaded.run('workspace.activeId'), initial);
  assert.equal(reloaded.run('Object.keys(workspace.profiles).length'), 2);
  assert.equal(reloaded.run('state.vocab.mastered.includes("num_one")'), true);
});

test('each device gets a distinct initial student identity', () => {
  assert.notEqual(fixture().run('workspace.activeId'), fixture().run('workspace.activeId'));
});

test('reset only affects the active profile and deleting the last profile is blocked', () => {
  const f = fixture();
  const first = f.run('workspace.activeId');
  f.run('markWord("num_one",true);markWord("num_one",true)');
  const second = f.run('addProfile("別の通信士")');
  f.run(`switchProfile(${JSON.stringify(second)});resetAll();switchProfile(${JSON.stringify(first)})`);
  assert.equal(f.run('state.vocab.mastered.includes("num_one")'), true);
  f.run(`deleteProfile(${JSON.stringify(second)})`);
  assert.equal(f.run(`deleteProfile(${JSON.stringify(first)})`), false);
});

test('lesson packs validate grade boundaries and never inflate rank', () => {
  const f = fixture();
  f.run('applyPack({...defaultPack("3-4"),category:"animals",count:5})');
  assert.equal(f.run('availableCategories().length'), 1);
  assert.equal(f.run('availablePhonics().every(item=>item.level===1)'), true);
  assert.equal(f.run('getProgress().totals.vocab[1]>10'), true);
  assert.throws(() => f.run('validatePack({...defaultPack("3-4"),level:3})'));
  assert.throws(() => f.run('validatePack({...defaultPack("3-4"),category:"months"})'));
  assert.throws(() => f.run('validatePack({...defaultPack("3-4"),scene:"shopping"})'));
  assert.throws(() => f.run('validatePack({...defaultPack(),count:10000})'));
  const link = f.run('packLink(defaultPack(),"https://example.test/english-station/")');
  const restored = JSON.parse(new URL(link).hash.slice('#lesson='.length) && decodeURIComponent(new URL(link).hash.slice('#lesson='.length)));
  assert.equal(restored.count, 10);
});

test('lesson answer quota rejects further answers and exiting restores free navigation', () => {
  const f = fixture();
  f.run('applyPack({...defaultPack(),count:5});ui.packAnswered=5;ui.activeView="vocab";ui.vocabMode="quiz";renderVocab()');
  f.click({ vocabChoice: f.run('ui.vocabQuiz.answer') });
  assert.equal(f.run('Object.keys(state.retention).length'), 0);
  f.click({}, ['data-exit-pack']);
  assert.equal(f.run('ui.pack'), null);
  assert.equal(f.run('availableCategories().length'), 20);
});

test('classroom snapshots deduplicate identities, reject stale imports, and do not replace active learning', () => {
  const f = fixture();
  f.run('markWord("num_one",true)');
  const exported = f.run('exportProgress()');
  f.run(`importClassSnapshot(${JSON.stringify(exported)})`);
  f.run(`importClassSnapshot(${JSON.stringify(exported)})`);
  assert.equal(f.run('workspace.snapshots.length'), 1);
  const older = JSON.parse(exported); older.exportedAt = '2000-01-01T00:00:00.000Z'; older.progress.vocab.records = {};
  assert.equal(f.run(`importClassSnapshot(${JSON.stringify(JSON.stringify(older))})`), false);
  assert.equal(f.run('state.vocab.records.num_one.correct'), 1);
  assert.equal(f.run('workspace.snapshots[0].progress.vocab.records.num_one.correct'), 1);
  assert.throws(() => f.run('importClassSnapshot("{}")'));
});

test('CSV output escapes formulas and quotations and quiz rows match template columns', () => {
  const f = fixture();
  const csv = f.run('csvText([["=1+1","@SUM(A1)","A\\\"B","safe"]])');
  assert.ok(csv.includes("'=1+1"));
  assert.ok(csv.includes("'@SUM(A1)"));
  assert.ok(csv.includes('A""B'));
  const rows = f.run('quizExportRows(vocabCategories.flatMap(category=>category.words))');
  assert.equal(rows.length, 200);
  for (const row of rows) {
    assert.equal(row.length, 7);
    assert.equal(row[5], 20);
    assert.ok(row[6] >= 1 && row[6] <= 4);
    assert.equal(new Set(row.slice(1, 5)).size, 4);
  }
});

test('every vocabulary quiz has four distinct picture cues', () => {
  const f = fixture();
  for (const id of f.run('availableWords().map(word=>word.id)')) {
    f.run(`createVocabQuiz(availableWords().find(word=>word.id===${JSON.stringify(id)}))`);
    assert.equal(f.run('new Set(ui.vocabQuiz.choices.map(pictureKey)).size'), 4, id);
    assert.equal(f.run('new Set(ui.vocabQuiz.choices.map(word=>word.en.toLowerCase())).size'), 4, id);
    const exercise = f.run(`exerciseFor({kind:"vocab",id:${JSON.stringify(id)}})`);
    assert.equal(new Set(exercise.choices.map(word => word.en.toLowerCase())).size, 4, id);
    assert.equal(new Set(exercise.choices.map(word => word.art || `${word.icon}:${word.color || ''}`)).size, 4, id);
  }
  for (const category of f.run('vocabCategories.map(category=>({id:category.id,grade:category.grade}))')) {
    f.run(`applyPack({...defaultPack(${JSON.stringify(category.grade[0])}),category:${JSON.stringify(category.id)}})`);
    for (const id of f.run('availableWords().map(word=>word.id)')) {
      f.run(`createVocabQuiz(availableWords().find(word=>word.id===${JSON.stringify(id)}))`);
      assert.equal(f.run('new Set(ui.vocabQuiz.choices.map(pictureKey)).size'), 4, `${category.id}/${id}`);
      assert.equal(f.run('new Set(ui.vocabQuiz.choices.map(word=>word.en.toLowerCase())).size'), 4, `${category.id}/${id}`);
    }
  }
});

test('new progress fields round trip and invalid retention keys are discarded', () => {
  const f = fixture();
  f.run('recordRetention("phonics","ph_a",true);state.personal.like="pizza";state.missions.completed=3;state.pairSessions.likes=2');
  const exported = f.run('exportProgress()');
  const restored = f.run(`parseProgressImport(${JSON.stringify(exported)})`);
  assert.equal(restored.personal.like, 'pizza');
  assert.equal(restored.missions.completed, 3);
  assert.equal(restored.pairSessions.likes, 2);
  assert.equal(restored.retention['phonics:ph_a'].correct, 1);
  assert.equal(f.run('Object.keys(normalizeState({retention:{"unknown:bad":{settled:true,successDays:["bad"]}}}).retention).length'), 0);
});

test('transferring progress preserves student identity for classroom deduplication', () => {
  const original = fixture();
  const id = original.run('state.studentId');
  const exported = original.run('exportProgress()');
  const otherDevice = fixture();
  assert.notEqual(otherDevice.run('state.studentId'), id);
  otherDevice.run(`replaceProgress(parseProgressImport(${JSON.stringify(exported)}))`);
  assert.equal(JSON.parse(otherDevice.run('exportProgress()')).student.id, id);
  otherDevice.run('resetAll()');
  assert.equal(otherDevice.run('state.studentId'), id);
});

test('personal text is never sent to a remote-only speech voice', async () => {
  const f = fixture();
  f.run('window.speechSynthesis.getVoices=()=>[{name:"Remote",lang:"en-US",localService:false}]');
  assert.equal(await f.run('speak("Hello. I am Ren.","en-US","A",false,true)'), false);
  assert.equal(f.utterances.length, 0);
});

test('lesson links omit existing URL query identifiers', () => {
  const f = fixture();
  const link = f.run('packLink(defaultPack(),"https://example.test/english-station/?student_id=private&name=Ren")');
  assert.equal(new URL(link).search, '');
  assert.ok(!link.includes('private'));
});
