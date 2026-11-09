const fs = require('node:fs');
const babel = require('@babel/core');
const html = fs.readFileSync('index.html', 'utf8');
const source = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];
babel.transformSync(source, {presets:[['@babel/preset-react',{runtime:'classic'}]],filename:'index.jsx'});
console.log('Frontend JSX compiles');

const manifest=JSON.parse(fs.readFileSync("appsscript.json","utf8"));
if(!manifest.oauthScopes.includes("https://www.googleapis.com/auth/userinfo.email")) throw new Error("Administrator migrations require the userinfo.email scope");

new (require("node:vm").Script)(fs.readFileSync("auth-session.js","utf8"), {filename:"auth-session.js"});
