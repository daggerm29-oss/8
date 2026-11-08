const http = require('node:http');
const { render } = require('./src/page.js');

const port = Number(process.env.PORT) || 3000;
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(render());
  })
  .listen(port, '127.0.0.1', () => console.log(`web-hello listening on http://127.0.0.1:${port}/`));
