/**
 * Renders the two images used on the Devpost project page:
 *   docs/devpost/architecture.png   system context diagram (1600 x 900)
 *   docs/devpost/thumbnail.png      project thumbnail, 3:2 (1500 x 1000)
 *
 * Every figure comes from data/evaluation/results.json, so the images cannot
 * drift from the measured results. Run `npm run eval` first if the harness changed.
 *
 *   node scripts/render-devpost-kit.mjs
 *
 * Set PLAYWRIGHT_CHROMIUM_PATH to use a browser other than the one Playwright installed.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const results = JSON.parse(readFileSync('data/evaluation/results.json', 'utf8'));
const { aftercare, baseline, careful } = results.totals;
const n = results.scenarioCount;
const original = results.sets[0];

const INK = '#17323f';
const PAPER = '#f5f7f6';
const GREEN = '#1f6f4a';
const LINE = '#b9c6cc';

const box = (x, y, w, h, title, lines, fill = '#ffffff', stroke = LINE) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
  <text x="${x + 18}" y="${y + 32}" font-size="20" font-weight="700" fill="${INK}">${title}</text>
  ${lines.map((l, i) => `<text x="${x + 18}" y="${y + 58 + i * 22}" font-size="15" fill="#4b6672">${l}</text>`).join('')}`;

const arrow = (x1, y1, x2, y2) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" stroke-width="2" marker-end="url(#a)"/>`;

const architecture = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${PAPER}">
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" font-family="Atkinson Hyperlegible Next, Segoe UI, Arial, sans-serif">
  <defs><marker id="a" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker></defs>
  <rect width="1600" height="900" fill="${PAPER}"/>
  <text x="50" y="60" font-size="32" font-weight="800" fill="${INK}">AFTERCARE architecture</text>
  <text x="50" y="92" font-size="17" fill="#4b6672">One Node.js process. Every interface calls the same services, and those ask one pure function what may happen next.</text>

  <text x="50" y="150" font-size="14" font-weight="700" fill="#4b6672">CLIENTS</text>
  ${box(50, 165, 300, 100, 'Assistant surface', ['Web MCP client, simulated', 'Alexa+ style'])}
  ${box(50, 295, 300, 100, 'Resolution Lab', ['Scripted customer over MCP,', 'read API for the trace'])}
  ${box(50, 425, 300, 100, 'Any MCP client', ['For example a voice assistant'])}

  <rect x="430" y="140" width="740" height="680" rx="16" fill="#eef3f2" stroke="${INK}" stroke-width="2"/>
  <text x="456" y="176" font-size="14" font-weight="700" fill="${INK}">AFTERCARE PROCESS</text>
  ${box(460, 195, 680, 80, 'HTTP layer (Express 5)', ['Host and Origin guard, optional bearer token, rate limit'])}
  ${box(460, 300, 330, 110, '/mcp', ['Spec 2025-11-25, stateless', 'Streamable HTTP, 10 typed tools'])}
  ${box(810, 300, 330, 110, '/api', ['Read model and demo controls'])}
  ${box(460, 435, 680, 90, 'Application services', ['Use cases, per case lock, transactions, write ahead operations,', 'reconciliation, postcondition verification'])}
  ${box(460, 550, 330, 110, 'Resolution Compiler', ['Pure and deterministic.', 'Approvals bound to a SHA-256 digest'], '#ffffff', GREEN)}
  ${box(810, 550, 330, 110, 'Interpreter port', ['Rules by default.', 'Optional model, claims only'])}
  ${box(460, 685, 680, 105, 'SQLite (node:sqlite)', ['Cases, evidence, assessments, proposals, approvals,', 'operations, events'])}

  <text x="1250" y="150" font-size="14" font-weight="700" fill="#4b6672">SIMULATED RETAILER</text>
  ${box(1250, 165, 300, 110, 'RetailerGateway', ['The only way in. Fictional', 'Kestrel Goods'])}
  ${box(1250, 305, 300, 110, 'sim_* tables', ['Own records and request log.', 'Never read directly'])}

  ${arrow(350, 215, 460, 235)}
  ${arrow(350, 345, 460, 245)}
  ${arrow(350, 475, 460, 255)}
  ${arrow(625, 275, 625, 300)}
  ${arrow(975, 275, 975, 300)}
  ${arrow(625, 410, 625, 435)}
  ${arrow(975, 410, 975, 435)}
  ${arrow(625, 525, 625, 550)}
  ${arrow(975, 525, 975, 550)}
  ${arrow(625, 660, 625, 685)}
  ${arrow(1140, 480, 1250, 225)}
  ${arrow(1400, 275, 1400, 305)}
  <text x="1250" y="470" font-size="14" fill="#4b6672">Outcomes are verified by reading</text>
  <text x="1250" y="490" font-size="14" fill="#4b6672">the return back from the retailer.</text>
</svg>`;

const bar = (label, value, color, y) => `
  <text x="90" y="${y}" font-size="26" fill="${INK}">${label}</text>
  <rect x="420" y="${y - 28}" width="820" height="34" rx="6" fill="#e3eaec"/>
  <rect x="420" y="${y - 28}" width="${Math.round((820 * value) / n)}" height="34" rx="6" fill="${color}"/>
  <text x="1262" y="${y}" font-size="28" font-weight="800" fill="${INK}">${value} / ${n}</text>`;

const thumbnail = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${PAPER}">
<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1000" viewBox="0 0 1500 1000" font-family="Atkinson Hyperlegible Next, Segoe UI, Arial, sans-serif">
  <rect width="1500" height="1000" fill="${PAPER}"/>
  <rect x="90" y="90" width="64" height="64" rx="16" fill="${INK}"/>
  <path d="M108 124 l12 12 l24 -26" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="178" y="140" font-size="56" font-weight="800" letter-spacing="3" fill="${INK}">AFTERCARE</text>
  <text x="90" y="260" font-size="46" font-weight="700" fill="${INK}">An assistant that knows when it</text>
  <text x="90" y="318" font-size="46" font-weight="700" fill="${INK}">cannot safely proceed.</text>
  <text x="90" y="385" font-size="26" fill="#4b6672">Self hosted MCP server. Evidence, policy and explicit approval decide each step.</text>

  <text x="90" y="500" font-size="22" font-weight="700" fill="#4b6672">CORRECT OUTCOMES, ${n} SIMULATED SCENARIOS</text>
  ${bar('AFTERCARE', aftercare.outcomeCorrect, GREEN, 570)}
  ${bar('Careful baseline', careful.outcomeCorrect, '#6a5a9c', 650)}
  ${bar('Baseline', baseline.outcomeCorrect, '#7a8b93', 730)}

  <text x="90" y="830" font-size="24" fill="${INK}">${aftercare.confirmedBeforeVerifying} returns confirmed before verification, against ${baseline.confirmedBeforeVerifying} for the baseline.</text>
  <text x="90" y="880" font-size="20" fill="#4b6672">Original ${original.scenarioIds.length} scenarios: AFTERCARE ${original.totals.aftercare.outcomeCorrect}, careful baseline ${original.totals.careful.outcomeCorrect}, baseline ${original.totals.baseline.outcomeCorrect}. Fictional retailer and data. Not an Amazon product.</text>
</svg>`;

mkdirSync('docs/devpost', { recursive: true });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({
  executablePath,
  args: executablePath ? ['--no-sandbox'] : [],
});
for (const [file, html, width, height] of [
  ['architecture', architecture, 1600, 900],
  ['thumbnail', thumbnail, 1500, 1000],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  await page.screenshot({ path: `docs/devpost/${file}.png` });
  await page.close();
  console.log(`wrote docs/devpost/${file}.png`);
}
await browser.close();
