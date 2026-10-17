// Reproduce a public :8081 proxy that strips the upstream Host port.
const http = require('node:http');
const port = Number(process.env.PROXY_PORT || 8081);
const upstreamPort = Number(process.env.UPSTREAM_PORT || 8011);
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/static/')) { res.writeHead(404); res.end(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
    headers: { ...req.headers, host: req.headers.host.replace(/:\d+$/, '') } }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  if (process.env.BLOCK_WEBSOCKETS === '1') {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url,
    headers: { ...req.headers, host: req.headers.host.replace(/:\d+$/, '') } });
  upstream.on('upgrade', (response, peer, peerHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key,value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (peerHead.length) socket.write(peerHead);
    if (head.length) peer.write(head);
    socket.pipe(peer).pipe(socket);
    socket.on('error', () => peer.destroy());
    peer.on('error', () => socket.destroy());
  });
  upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nContent-Length: 0\r\n\r\n`); });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});
server.listen(port, '127.0.0.1', () => console.log(`Proxy ready on ${port}; WebSockets ${process.env.BLOCK_WEBSOCKETS === '1' ? 'blocked' : 'enabled'}`));
