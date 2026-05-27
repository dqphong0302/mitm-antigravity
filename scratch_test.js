const https = require('https');

const body = JSON.stringify({
  request: {
    model: "gemini-3.1-pro-high",
    contents: [{"role": "user", "parts": [{"text": "hi"}]}]
  },
  model_id: "gemini-3.1-pro-high",
  targetModel: "gemini-3.1-pro-high"
});

const req = https.request({
  hostname: 'localhost',
  port: 443,
  path: '/v1internal:streamGenerateContent?alt=sse',
  method: 'POST',
  rejectUnauthorized: false,
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-goog-api-key': 'some-key',
    'user-agent': 'grpc-node-js/1.64.0'
  }
}, res => {
  console.log(`Status: ${res.statusCode}`);
  res.on('data', d => process.stdout.write(d));
});

req.on('error', e => console.error(e));
req.write(body);
req.end();
