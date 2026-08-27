// Serves the app on http://localhost:8080, because pdf.js cannot load its worker
// from a file:// page and a service worker cannot be registered there either.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.pdf': 'application/pdf',
};

http.createServer((req, res) => {
  const asked = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, asked === '/' ? 'index.html' : asked);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      // no caching, so an edited file shows up on the next reload
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}).listen(8080, () => console.log('Book Scan Cleaner on http://localhost:8080'));
