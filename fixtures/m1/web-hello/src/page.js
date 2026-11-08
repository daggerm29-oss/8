const escapeHtml = require('escape-html');

const TITLE = 'Web Hello';
const HEADING = 'Hello World';

function render() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${escapeHtml(TITLE)}</title></head>
  <body>
    <h1>${escapeHtml(HEADING)}</h1>
    <p>A tiny fixture app for the Helix M1 demo.</p>
  </body>
</html>
`;
}

module.exports = { render };
