const https = require('https');

https.get('https://html.duckduckgo.com/html/?q=Plum+Alley+Ventures+website', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log("Body length:", data.length);
    const regex = /uddg=([^&"'>\s]+)/g;
    const matches = [...data.matchAll(regex)].map(m => decodeURIComponent(m[1]));
    console.log("Matches count:", matches.length);
    console.log(matches.slice(0, 10));
  });
}).on('error', (e) => {
  console.error("Error:", e.message);
});
