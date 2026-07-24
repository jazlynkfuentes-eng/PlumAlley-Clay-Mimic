import fs from 'fs';
const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('const companyDictionary = {');
const end = html.indexOf('\n    };', start);
const block = html.slice(start, end);
const keys = [...block.matchAll(/"([^"]+)":\s*\{/g)].map((x) => x[1]);
const uniqueDomains = new Map();
for (const key of keys) {
  const m = block.match(new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\s*\\{[\\s\\S]*?domain:\\s*"([^"]+)"`));
  if (m) uniqueDomains.set(m[1], key);
}
console.log('keys', keys.length);
console.log('unique domains', uniqueDomains.size);
console.log([...uniqueDomains.entries()].map(([d, k]) => `${k}\t${d}`).join('\n'));
