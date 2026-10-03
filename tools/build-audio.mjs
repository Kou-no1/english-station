import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(directory, '../index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({});
vm.runInContext(script.slice(0, script.indexOf('    // Generated')) + '\nglobalThis.items = phonicsItems;', context);
const input = context.items.map(item => ({ id: item.id, example: item.example, phones: item.ipa.replaceAll('/', '') }));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'english-phonics-'));
const inputPath = path.join(temporary, 'input.json');
const outputPath = path.join(temporary, 'audio.json');
fs.writeFileSync(inputPath, JSON.stringify(input));
const result = spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'synthesize-audio.ps1'), '-InputPath', inputPath, '-OutputPath', outputPath], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Audio generation failed');
const { voice, samples } = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
for (const item of input) {
  const bytes = Buffer.from(samples[item.id], 'base64');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.length < 1000) throw new Error(`Invalid audio: ${item.id}`);
}
fs.writeFileSync(htmlPath, html.replace(/\/\* AUDIO_START \*\/[\s\S]*?\/\* AUDIO_END \*\//, `/* AUDIO_START */${JSON.stringify(samples)}/* AUDIO_END */`));
console.log(`Embedded ${input.length} IPA samples with ${voice}; ${fs.statSync(htmlPath).size} bytes.`);
