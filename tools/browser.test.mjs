import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const htmlPath = fileURLToPath(new URL('../index.html', import.meta.url));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'english-browser-'));
const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'english-screens-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
let server;
let closeBrowser;
try {
  let port;
  for (let index = 0; index < 100; index++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await sleep(100); }
  }
  if (!port) throw new Error('Chrome did not start. Set CHROME_PATH to the browser executable.');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, method === 'Runtime.evaluate' ? 30000 : 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  closeBrowser = () => call('Browser.close');
  const evaluate = async expression => {
    let result;
    try { result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); }
    catch (error) { throw new Error(`${error.message}: ${expression.slice(0, 180)}`); }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.navigate', { url: pathToFileURL(htmlPath).href });
  for (let index = 0; index < 60; index++) { if (await evaluate('document.readyState === "complete" && typeof ui !== "undefined"')) break; await sleep(100); }
  const layouts = [];
  for (const [width, height] of [[1280, 900], [768, 1024], [390, 844]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 620 });
    for (const view of ['home', 'vocab', 'phonics', 'smalltalk', 'gacha', 'review', 'mission', 'pair', 'teacher']) {
      await evaluate(`setView(${JSON.stringify(view)})`);
      await sleep(220);
      const layout = await evaluate('({view:ui.activeView,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,contentY:document.querySelector(".view.active").getBoundingClientRect().top,overflowing:[...document.querySelectorAll(".view.active button")].filter(b=>b.getBoundingClientRect().right>innerWidth+1||b.getBoundingClientRect().left<0).map(b=>b.textContent.trim())})');
      if (layout.scrollWidth > width) {
        const elements = await evaluate('[...document.querySelectorAll(".app-shell *")].filter(element=>element.getClientRects().length&&(element.getBoundingClientRect().right>innerWidth+1||element.getBoundingClientRect().left<0)).slice(0,20).map(element=>({tag:element.tagName,class:element.className.baseVal??element.className,text:element.textContent.trim().slice(0,100),right:element.getBoundingClientRect().right}))');
        throw new Error(`${view} overflows at ${width}px: ${JSON.stringify({layout,elements})}`);
      }
      assert.deepEqual(layout.overflowing, [], `${view} buttons overflow at ${width}px`);
      if (width === 390) assert.ok(layout.contentY < 370, `${view} content starts too far down: ${layout.contentY}`);
      layouts.push(layout);
      if (['home', 'vocab', 'phonics', 'smalltalk', 'gacha', 'pair', 'teacher'].includes(view)) {
        const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(path.join(screenshots, `${view}-${width}.png`), Buffer.from(capture.data, 'base64'));
      }
    }
  }
  const colors = [];
  for (const id of ['color_red', 'color_blue']) {
    await evaluate(`setView("vocab");ui.vocabCategory="numbers_colors";ui.vocabIndex=vocabCategories[0].words.findIndex(w=>w.id===${JSON.stringify(id)});renderVocab()`);
    colors.push(await evaluate('getComputedStyle(document.querySelector(".view.active .word-art")).color'));
  }
  assert.notEqual(colors[0], colors[1]);
  const audio = await evaluate('(async()=>{const context=new AudioContext();const results=[];for(const item of phonicsItems){const data=Uint8Array.from(atob(phonicsAudio[item.id]),char=>char.charCodeAt(0));const sample=await context.decodeAudioData(data.buffer);let peak=0;for(const point of sample.getChannelData(0))peak=Math.max(peak,Math.abs(point));if(peak<0.001||sample.duration<0.05)throw new Error("Empty sound "+item.id);results.push({id:item.id,duration:sample.duration})}await context.close();return results})()');
  const until = async expression => { for (let index = 0; index < 100; index++) { if (await evaluate(expression)) return; await sleep(50); } const state = await evaluate('({url:location.href,ready:document.readyState,notice:document.getElementById("save-notice")?.textContent,pending:typeof ui!=="undefined"?ui.pendingPack:null})'); throw new Error(`Did not complete: ${expression}\n${JSON.stringify(state)}\n${errors.join("\n")}`); };
  await evaluate('window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};Object.defineProperty(window,"speechSynthesis",{configurable:true,value:{cancel(){},getVoices(){return [{name:"Test A",lang:"en-US",localService:true},{name:"Test B",lang:"en-US",localService:true}]},speak(utterance){setTimeout(()=>utterance.onend?.(),0)}}});true');
  await evaluate('setView("smalltalk");resetTalk("can_do");renderSmallTalk();document.querySelector("[data-block-group=answer]").focus();document.querySelector("[data-block-group=answer]").click()');
  assert.equal(await evaluate('document.activeElement.dataset.blockGroup'), 'answer', 'Focus was lost after selecting a block');
  await evaluate('resetTalk("shopping");renderSmallTalk()');
  for (let turn = 0; turn < 3; turn++) {
    await evaluate('(()=>{const topic=smallTalkTopics.find(t=>t.id===ui.smallTalkTopic);const round=talkRound(topic);for(const group of Object.keys(round.blocks)){const option=blockOptions(round,group)[0];[...document.querySelectorAll(".view.active [data-block-group]")].find(b=>b.dataset.blockGroup===group&&b.dataset.blockValue===option).click()}document.querySelector(".view.active [data-send-talk]").click()})()');
  }
  assert.equal(await evaluate('ui.talkFinished && state.smalltalk.completedTopics.includes("shopping")'), true);
  await evaluate('setView("home");document.querySelector("a[data-sky-word=animal_dog]").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))');
  assert.equal(await evaluate('document.getElementById("word-dialog").open'), true);
  await evaluate('document.querySelector("[data-close-dialog=word-dialog]").click();document.getElementById("teacher-button").click()');
  assert.equal(await evaluate('document.getElementById("teacher-dialog").open'), true);
  await evaluate('(()=>{const slider=document.getElementById("speech-speed");slider.value="0";slider.dispatchEvent(new Event("input",{bubbles:true}));const projection=document.querySelector("[data-setting=projection]");projection.checked=true;projection.dispatchEvent(new Event("change",{bubbles:true}))})()');
  assert.equal(await evaluate('state.settings.rate===0.7 && document.body.classList.contains("projection")'), true);
  await evaluate('(()=>{const projection=document.querySelector("[data-setting=projection]");projection.checked=false;projection.dispatchEvent(new Event("change",{bubbles:true}));const transfer=new DataTransfer();transfer.items.add(new File([exportProgress()],"progress.json",{type:"application/json"}));const input=document.getElementById("progress-file");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()');
  await until('document.getElementById("import-dialog").open');
  assert.equal(await evaluate('ui.pendingImport.smalltalk.completedTopics.includes("shopping")'), true);
  await evaluate('document.querySelector("[data-confirm-import]").click()');
  assert.equal(await evaluate('state.smalltalk.completedTopics.includes("shopping") && document.getElementById("teacher-dialog").open'), true);
  await evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File(["{}"],"wrong.json",{type:"application/json"}));const input=document.getElementById("progress-file");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()');
  await until('document.getElementById("teacher-status").textContent.includes("学年")');
  assert.equal(await evaluate('state.smalltalk.completedTopics.includes("shopping")'), true);
  const teacherCapture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(screenshots, 'teacher-mobile.png'), Buffer.from(teacherCapture.data, 'base64'));
  await evaluate('document.querySelector("[data-close-dialog=teacher-dialog]").click();setView("gacha");document.querySelector("[data-gacha-draw]").click();document.querySelector("[data-gacha-draw]").click()');
  assert.equal(await evaluate('ui.gachaSpinning && document.querySelector("[data-gacha-draw]").disabled'), true);
  await until('!ui.gachaSpinning');
  assert.equal(await evaluate('state.gacha.collected.length'), 1);
  await evaluate('[...document.querySelectorAll(".view.active [data-scene-choice]")].find(button=>button.dataset.sceneChoice===ui.sceneQuiz.answer).click()');
  assert.equal(await evaluate('state.gacha.practiced.length'), 1);
  assert.notEqual(await evaluate('document.querySelector("[data-feedback=scene]").textContent'), '');
  const persisted = await evaluate('JSON.stringify({talk:state.smalltalk.completedTopics,cards:state.gacha.practiced,rate:state.settings.rate})');
  const previousNavigation = await evaluate('performance.timeOrigin');
  await call('Page.reload');
  await until(`performance.timeOrigin>${previousNavigation} && document.readyState==="complete" && typeof ui!=="undefined"`);
  assert.equal(await evaluate('JSON.stringify({talk:state.smalltalk.completedTopics,cards:state.gacha.practiced,rate:state.settings.rate})'), persisted);
  await evaluate('document.getElementById("grade-34").click();setView("vocab");ui.vocabMode="quiz";renderVocab()');
  assert.equal(await evaluate('state.settings.subtitles'), false);
  assert.equal(await evaluate('document.querySelector(".view.active [data-vocab-choice]").textContent.trim().length>0'), true);
  await evaluate('document.getElementById("grade-56").click();startMission()');
  for (let step = 0; step < 4; step++) {
    if (step < 3) await evaluate('[...document.querySelectorAll("[data-mission-choice]")].find(button=>button.dataset.missionChoice===ui.mission.steps[ui.mission.index].id).click()');
    else {
      await evaluate('(()=>{const check=document.querySelector("[data-mission-talk]");check.checked=true;check.dispatchEvent(new Event("change",{bubbles:true}))})()');
      await until('!document.querySelector("[data-mission-send]").disabled');
      await evaluate('document.querySelector("[data-mission-send]").click()');
    }
    await evaluate('document.querySelector("[data-mission-next]").click()');
  }
  await evaluate('setView("vocab");document.querySelector("[data-vocab-mode=flash]").click();const themeSelect=document.querySelector("[data-topic-select=vocab]");themeSelect.value="animals";themeSelect.dispatchEvent(new Event("change",{bubbles:true}));true');
  assert.equal(await evaluate('ui.vocabCategory'), 'animals');
  assert.equal(await evaluate('document.querySelector("[data-vocab-known]")===null'), true);
  await evaluate('document.querySelector("[data-vocab-reveal]").click()');
  assert.equal(await evaluate('document.querySelector("[data-vocab-known]")!==null && document.querySelector("[data-vocab-reveal]")===null'), true);
  assert.equal(await evaluate('document.querySelector("[data-vocab-known]").getBoundingClientRect().bottom<=innerHeight'), true, 'The vocabulary self-check should be visible on mobile without scrolling');
  const revealCapture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(screenshots, 'vocab-revealed-mobile.png'), Buffer.from(revealCapture.data, 'base64'));
  await evaluate('document.querySelector("[data-vocab-next]").click()');
  assert.equal(await evaluate('ui.vocabRevealed'), false);
  await evaluate('setView("smalltalk");const talkSelect=document.querySelector("[data-topic-select=talk]");talkSelect.value="shopping";talkSelect.dispatchEvent(new Event("change",{bubbles:true}));true');
  assert.equal(await evaluate('ui.smallTalkTopic'), 'shopping');
  assert.equal(await evaluate('state.missions.completed'), 1);
  await evaluate('startPair();ui.pair.topic="likes";renderPair();document.querySelector("details").open=true;const field=document.querySelector("[data-personal=like]");field.value="curry";field.dispatchEvent(new Event("change",{bubbles:true}))');
  await until('state.personal.like==="curry"');
  for (let turn = 0; turn < 4; turn++) await evaluate('document.querySelector("[data-pair-next]").click()');
  for (let index = 0; index < 3; index++) {
    await evaluate(`(()=>{const input=[...document.querySelectorAll("[data-pair-check]")].find(input=>input.dataset.pairCheck===${JSON.stringify(String(index))});input.checked=true;input.dispatchEvent(new Event("change",{bubbles:true}))})()`);
  }
  await until('!document.querySelector("[data-pair-complete]").disabled');
  await evaluate('document.querySelector("[data-pair-complete]").click()');
  assert.equal(await evaluate('state.pairSessions.likes'), 1);
  await evaluate('state.phonics.mastered=[...new Set([...state.phonics.mastered,"ph_b"])];if(state.retention["phonics:ph_b"])state.retention["phonics:ph_b"].dueAt=0;startUnifiedReview()');
  assert.ok(await evaluate('ui.unifiedReview.queue.some(item=>item.kind==="phonics")'));
  await evaluate('setView("teacher");ui.teacherTab="packs";renderTeacher();document.getElementById("pack-title").value="テスト授業";document.getElementById("pack-textbook").value="学校の教材";document.getElementById("pack-unit").value="好きなもの";document.querySelector("[data-pack-save]").click();document.querySelector("[data-pack-share]").click()');
  assert.equal(await evaluate('workspace.packs.length'), 1);
  assert.equal(await evaluate('workspace.packs[0].unit'), '好きなもの');
  assert.ok((await evaluate('document.getElementById("share-link").value')).includes('#lesson='));
  await evaluate('document.querySelector("[data-pack-apply]").click()');
  assert.equal(await evaluate('ui.pack.title==="テスト授業"&&availableCategories().length===1&&!document.getElementById("session-bar").hidden'), true);
  await evaluate('document.querySelector("[data-exit-pack]").click();document.getElementById("profile-button").click();document.getElementById("new-profile-label").value="通信士テスト";document.querySelector("[data-profile-add]").click()');
  assert.equal(await evaluate('Object.keys(workspace.profiles).length'), 2);
  assert.equal(await evaluate('state.missions.completed'), 0);
  await evaluate('document.querySelector("[data-close-dialog=profile-dialog]").click();setView("teacher");ui.teacherTab="classroom";renderTeacher();document.querySelector("[data-class-current]").click()');
  assert.equal(await evaluate('workspace.snapshots.length'), 1);
  await evaluate('(()=>{const existing=JSON.parse(exportProgress());existing.student.id="p_imported_test";existing.student.label="読み込み通信士";const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(existing)],"student.json",{type:"application/json"}));transfer.items.add(new File(["{}"],"wrong.json",{type:"application/json"}));const input=document.getElementById("class-files");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()');
  await until('workspace.snapshots.length===2 && ui.teacherNotice.includes("wrong.json")');
  await evaluate('ui.teacherTab="materials";renderTeacher();window.print=()=>{window.printCalled=true};document.querySelector("[data-material-print]").click()');
  assert.equal(await evaluate('window.printCalled && document.querySelectorAll(".print-card").length===10'), true);
  await call('Emulation.setEmulatedMedia', { media: 'print' });
  assert.equal(await evaluate('getComputedStyle(document.getElementById("print-area")).display'), 'block');
  const printCapture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(screenshots, 'print-cards.png'), Buffer.from(printCapture.data, 'base64'));
  await call('Emulation.setEmulatedMedia', { media: '' });
  for (const tab of ['profiles', 'classroom', 'materials']) {
    await evaluate(`ui.teacherTab=${JSON.stringify(tab)};renderTeacher()`);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `${tab} overflows`);
    const capture = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(screenshots, `teacher-${tab}-mobile.png`), Buffer.from(capture.data, 'base64'));
  }
  await evaluate('(()=>{const data=Uint8Array.from(atob(phonicsAudio.ph_a),char=>char.charCodeAt(0));const file=new File([data],"a.wav",{type:"audio/wav"});return importSignalAudio(file,"ph_a")})()');
  assert.equal(await evaluate('audioOverrides.has("ph_a")'), true);
  await evaluate('ui.audioTarget="ph_a";renderTeacher();const check=document.getElementById("audio-checked");check.checked=true;check.dispatchEvent(new Event("change",{bubbles:true}))');
  assert.equal(await evaluate('workspace.audioChecks.includes("ph_a")'), true);
  const advancedPersistence = await evaluate('JSON.stringify({profiles:Object.keys(workspace.profiles),snapshots:workspace.snapshots.length,packs:workspace.packs.length,checks:workspace.audioChecks})');
  const advancedNavigation = await evaluate('performance.timeOrigin');
  await call('Page.reload');
  await until(`performance.timeOrigin>${advancedNavigation} && document.readyState==="complete" && typeof ui!=="undefined"`);
  await until('audioOverrides.has("ph_a")');
  assert.equal(await evaluate('JSON.stringify({profiles:Object.keys(workspace.profiles),snapshots:workspace.snapshots.length,packs:workspace.packs.length,checks:workspace.audioChecks})'), advancedPersistence);
  const directory = path.dirname(htmlPath);
  const allowedAssets = new Set(['index.html', 'sw.js', 'station.css', 'assets/guide.webp', 'manifest.webmanifest', 'station.svg']);
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const filename = pathname === '/english-station/' ? 'index.html' : pathname.slice('/english-station/'.length);
    if (!pathname.startsWith('/english-station/') || !allowedAssets.has(filename)) { response.writeHead(404); response.end(); return; }
    const mime = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.webp') ? 'image/webp' : filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html';
    response.writeHead(200, { 'Content-Type': `${mime};charset=utf-8` });
    response.end(fs.readFileSync(path.join(directory, filename)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const siteUrl = `http://127.0.0.1:${server.address().port}/english-station/`;
  await call('Page.navigate', { url: siteUrl });
  await until('location.protocol==="http:" && typeof ui!=="undefined" && ui.offlineStatus.includes("保存しました") && navigator.serviceWorker.controller!==null');
  const shared = await evaluate('packLink({...defaultPack("3-4"),title:"共有テスト"})');
  await call('Page.navigate', { url: shared });
  await until('document.getElementById("pack-dialog")?.open');
  await evaluate('document.querySelector("[data-confirm-pack]").click()');
  assert.equal(await evaluate('ui.pack.title==="共有テスト"&&state.gradeMode==="3-4"'), true);
  await call('Network.enable');
  await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const offlineNavigation = await evaluate('performance.timeOrigin');
  await call('Page.reload');
  await until(`performance.timeOrigin>${offlineNavigation} && document.readyState==="complete" && typeof ui!=="undefined" && document.getElementById("pack-dialog")?.open`);
  assert.equal(await evaluate('document.querySelector("h1").textContent'), '星間通信局');
  assert.equal(await evaluate('vocabCategories.flatMap(category=>category.words).length'), 200);
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(247, 249, 251)');
  assert.equal(await evaluate('document.querySelector(".guide-header img").complete && document.querySelector(".guide-header img").naturalWidth>0'), true);
  await call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ passed: true, layouts, decodedAudio: audio.length, flows: ['keyboard focus', 'shopping conversation', 'star dialog', 'teacher settings', 'import preview and validation', 'single-flight gacha', 'scene mastery', 'reload persistence', 'younger grade', 'four-department mission', 'personal pair conversation', 'unified review', 'lesson pack save and share', 'profile switching', 'classroom batch import', 'print cards', 'audio replacement and persistence', 'shared lesson confirmation', 'offline reload'], screenshots }, null, 2));
} finally {
  if (socket?.readyState === WebSocket.OPEN) await closeBrowser?.().catch(() => {});
  socket?.close();
  if (chrome.exitCode === null) chrome.kill();
  if (server) await new Promise(resolve => server.close(resolve));
}
