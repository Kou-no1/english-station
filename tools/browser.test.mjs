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
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ passed: true, layouts, decodedAudio: audio.length, screenshots }, null, 2));
  await call('Browser.close').catch(() => {});
} finally {
  socket?.close();
  if (chrome.exitCode === null) chrome.kill();
}
