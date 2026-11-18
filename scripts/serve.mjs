// Tiny static server for the exported build: `npm run build && npm run serve` → http://localhost:3000
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('out');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.exr': 'image/x-exr', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  let f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log(`FIT RUN on http://localhost:${port}`));
