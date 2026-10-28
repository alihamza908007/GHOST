import http from 'http';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Demo App</title>
        <style>
          body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f0f0; }
          .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #333; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>GHOST Demo Application</h1>
          <p>If you can see this, Playwright successfully navigated.</p>
        </div>
      </body>
    </html>
  `);
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Demo target running at http://127.0.0.1:${PORT}`);
});
