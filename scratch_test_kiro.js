const https = require('https');

async function testModel(modelName) {
  const body = JSON.stringify({
    model: modelName,
    contents: [{"role": "user", "parts": [{"text": "hi"}]}]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'localhost',
      port: 8080,
      path: '/v1internal:streamGenerateContent?alt=sse',
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'user-agent': 'grpc-node-js/1.64.0'
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log("Testing kr/claude-sonnet-4.6...");
  const res1 = await testModel("kr/claude-sonnet-4.6");
  console.log(`Status 1: ${res1.status}`);
  console.log(`Data 1: ${res1.data.substring(0, 100)}`);
  
  console.log("\nTesting kr/claude-sonnet-4.6-thinking-agentic...");
  const res2 = await testModel("kr/claude-sonnet-4.6-thinking-agentic");
  console.log(`Status 2: ${res2.status}`);
  console.log(`Data 2: ${res2.data.substring(0, 100)}`);
})();
