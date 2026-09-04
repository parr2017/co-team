const http = require('http');

async function checkAgentApi() {
  console.log('Checking /api/agents endpoint...');
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 8000, // Assuming default port from logs
      path: '/api/agents',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`Status Code: ${res.statusCode}`);
        if (res.statusCode === 200) {
          console.log('SUCCESS: /api/agents is available');
          try {
            const json = JSON.parse(data);
            console.log('Received agents:', JSON.stringify(json, null, 2));
            resolve(true);
          } catch (e) {
            console.error('Failed to parse response JSON');
            resolve(false);
          }
        } else {
          console.log(`FAILED: /api/agents returned ${res.statusCode}. This confirms the missing data link.`);
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.error(`Request error: ${e.message}`);
      resolve(false);
    });

    req.end();
  });
}

checkAgentApi().then(success => {
  process.exit(success ? 0 : 1);
});