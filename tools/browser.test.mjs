import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const htmlPath = fileURLToPath(new URL('../index.html', import.meta.url));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'english-browser-'));
const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'english-screens-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
    for (const view of ['home', 'vocab', 'phonics', 'smalltalk', 'gacha']) {
      await evaluate(`setView(${JSON.stringify(view)})`);
      await sleep(220);
      const layout = await evaluate('({view:ui.activeView,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,contentY:document.querySelector(".view.active").getBoundingClientRect().top,overflowing:[...document.querySelectorAll(".view.active button")].filter(b=>b.getBoundingClientRect().right>innerWidth+1||b.getBoundingClientRect().left<0).map(b=>b.textContent.trim())})');
      assert.ok(layout.scrollWidth <= width, `${view} overflows at ${width}px`);
      assert.deepEqual(layout.overflowing, [], `${view} buttons overflow at ${width}px`);
      if (width === 390) assert.ok(layout.contentY < 370, `${view} content starts too far down: ${layout.contentY}`);
      layouts.push(layout);
      if (view === 'home' || view === 'vocab' || view === 'smalltalk') {
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
  const until = async expression => { for (let index = 0; index < 30; index++) { if (await evaluate(expression)) return; await sleep(50); } throw new Error(`Did not complete: ${expression}`); };
  await evaluate('window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};Object.defineProperty(window,"speechSynthesis",{configurable:true,value:{cancel(){},getVoices(){return [{name:"Test A",lang:"en-US"},{name:"Test B",lang:"en-US"}]},speak(utterance){setTimeout(()=>utterance.onend?.(),0)}}});true');
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
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ passed: true, layouts, decodedAudio: audio.length, flows: ['keyboard focus', 'shopping conversation', 'star dialog', 'teacher settings', 'import preview and validation', 'single-flight gacha', 'scene mastery', 'reload persistence', 'younger grade'], screenshots }, null, 2));
  await call('Browser.close').catch(() => {});
} finally {
  socket?.close();
  if (chrome.exitCode === null) chrome.kill();
}
