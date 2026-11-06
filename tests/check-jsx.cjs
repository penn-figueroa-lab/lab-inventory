const fs = require('node:fs');
const babel = require('@babel/core');
const html = fs.readFileSync('index.html', 'utf8');
const source = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];
babel.transformSync(source, {presets:[['@babel/preset-react',{runtime:'classic'}]],filename:'index.jsx'});
console.log('Frontend JSX compiles');
