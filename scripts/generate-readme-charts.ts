import { mkdirSync, writeFileSync } from 'node:fs';
import { solve, applyWhatIf, type SolverRequest, type SolverResource } from '../spacetimedb/src/solver.ts';
const out = new URL('../docs/readme/', import.meta.url);
mkdirSync(out, { recursive: true });
const resources: SolverResource[] = [
  { resourceId: 'accessible', kind: 'charger_slot', accessible: true, available: 1 },
  { resourceId: 'general', kind: 'charger_slot', accessible: false, available: 1 },
  { resourceId: 'water', kind: 'water_stock', accessible: false, available: 2 },
];
const request = (id: number, accessible = false, kind: 'charging' | 'water' = 'charging'): SolverRequest => ({
  requestPk: BigInt(id), kind, needsAccessible: accessible, quantity: 1,
  receivedAtMicros: BigInt(id), humanPriority: 0, state: 'acknowledged',
});
const mixed = [request(1), request(2, true)];
const constrained = [request(1, true), request(2, true)];
const rows = [
  { label: 'First-come', scenario: 'Mixed charging needs', plan: solve('fcfs', mixed, resources) },
  { label: 'Suitability', scenario: 'Mixed charging needs', plan: solve('suitability', mixed, resources) },
  { label: 'Current capacity', scenario: 'Two accessible requests', plan: solve('suitability', constrained, resources) },
  { label: '+1 accessible charger', scenario: 'Two accessible requests', plan: solve('suitability', constrained, applyWhatIf(resources, [{ kind: 'charger_slot', accessible: true, count: 1 }])) },
  { label: 'Water stock: 2 units', scenario: 'Three one-unit requests', plan: solve('fcfs', [request(1,false,'water'),request(2,false,'water'),request(3,false,'water')], resources) },
];
const data = rows.map(({label,scenario,plan}) => ({label,scenario,matched:plan.assignments.length,unmatched:plan.unmatched.length,method:plan.method}));
writeFileSync(new URL('matcher-data.json',out), JSON.stringify(data,null,2)+'\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="610" viewBox="0 0 1100 610" role="img" aria-labelledby="title desc">
<title id="title">Deterministic matcher: requests served by scenario</title><desc id="desc">Synthetic fixtures, not live shelter metrics. ${data.map(r=>`${r.label}: ${r.matched} matched, ${r.unmatched} unmatched.`).join(' ')}</desc>
<rect width="1100" height="610" rx="24" fill="#0d0c11"/>
<g font-family="Arial, sans-serif"><text x="48" y="52" fill="#ed66b7" font-size="12" letter-spacing="3">RELAYAID / MATCHER LAB</text><text x="48" y="96" fill="#f5f3f5" font-size="30">Small scenarios. Visible tradeoffs.</text><text x="48" y="127" fill="#aaa5af" font-size="15">Requests matched · actual solver output · synthetic inputs</text>
${[0,1,2,3].map(n=>`<path d="M${360+n*205} 165V520" stroke="#29242e"/><text x="${360+n*205}" y="550" fill="#aaa5af" font-size="13" text-anchor="middle">${n}</text>`).join('')}
${data.map((r,i)=>{const y=180+i*70;return `<text x="48" y="${y+15}" fill="#f5f3f5" font-size="16">${r.label}</text><text x="48" y="${y+35}" fill="#aaa5af" font-size="12">${r.scenario}</text><rect x="360" y="${y}" width="${r.matched*205}" height="32" rx="5" fill="#ed66b7"/>${r.unmatched?`<rect x="${360+r.matched*205}" y="${y}" width="${r.unmatched*205}" height="32" rx="5" fill="#3d3544"/>`:''}<text x="${360+r.matched*205-12}" y="${y+21}" fill="#260d1e" text-anchor="end" font-size="14">${r.matched}</text>`}).join('')}
<rect x="48" y="575" width="12" height="12" rx="3" fill="#ed66b7"/><text x="70" y="586" fill="#aaa5af" font-size="13">Matched</text><rect x="170" y="575" width="12" height="12" rx="3" fill="#3d3544"/><text x="192" y="586" fill="#aaa5af" font-size="13">Unmatched</text><text x="1052" y="586" text-anchor="end" fill="#aaa5af" font-size="12">Regenerate: npm run docs:charts</text></g></svg>`;
writeFileSync(new URL('matcher-chart.svg',out),svg+'\n');
console.log(JSON.stringify(data,null,2));
