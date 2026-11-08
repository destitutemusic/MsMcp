const http = require('http');

// Mock Mixing Station REST API
// Simulates a Behringer X32 mixer with 32 channels, 8 buses, 4 matrices, 4 mains, 16 DCAs

const MOCK_PARAMS = {};
const SUBSCRIBERS = {};

// Generate mock parameters
function generateMockParams() {
    // 32 channels
    for (let i = 0; i < 32; i++) {
        MOCK_PARAMS[`ch.${i}.mix.lvl`] = { value: -10, type: 'float', min: -90, max: 10, unit: 'dB' };
        MOCK_PARAMS[`ch.${i}.mix.mute`] = { value: false, type: 'bool' };
        MOCK_PARAMS[`ch.${i}.eq.1.freq`] = { value: 100, type: 'float', min: 20, max: 20000, unit: 'Hz' };
        MOCK_PARAMS[`ch.${i}.eq.1.gain`] = { value: 0, type: 'float', min: -15, max: 15, unit: 'dB' };
        MOCK_PARAMS[`ch.${i}.eq.1.q`] = { value: 1.0, type: 'float', min: 0.1, max: 10 };
        MOCK_PARAMS[`ch.${i}.eq.2.freq`] = { value: 500, type: 'float', min: 20, max: 20000, unit: 'Hz' };
        MOCK_PARAMS[`ch.${i}.eq.2.gain`] = { value: 0, type: 'float', min: -15, max: 15, unit: 'dB' };
        MOCK_PARAMS[`ch.${i}.eq.2.q`] = { value: 1.0, type: 'float', min: 0.1, max: 10 };
        MOCK_PARAMS[`ch.${i}.eq.3.freq`] = { value: 2500, type: 'float', min: 20, max: 20000, unit: 'Hz' };
        MOCK_PARAMS[`ch.${i}.eq.3.gain`] = { value: 0, type: 'float', min: -15, max: 15, unit: 'dB' };
        MOCK_PARAMS[`ch.${i}.eq.3.q`] = { value: 1.0, type: 'float', min: 0.1, max: 10 };
        MOCK_PARAMS[`ch.${i}.eq.4.freq`] = { value: 10000, type: 'float', min: 20, max: 20000, unit: 'Hz' };
        MOCK_PARAMS[`ch.${i}.eq.4.gain`] = { value: 0, type: 'float', min: -15, max: 15, unit: 'dB' };
        MOCK_PARAMS[`ch.${i}.eq.4.q`] = { value: 1.0, type: 'float', min: 0.1, max: 10 };
        MOCK_PARAMS[`ch.${i}.dyn.threshold`] = { value: -20, type: 'float', min: -60, max: 0, unit: 'dB' };
        MOCK_PARAMS[`ch.${i}.dyn.ratio`] = { value: 2.0, type: 'float', min: 1, max: 20 };
        MOCK_PARAMS[`ch.${i}.dyn.attack`] = { value: 10, type: 'float', min: 0.1, max: 100, unit: 'ms' };
        MOCK_PARAMS[`ch.${i}.dyn.release`] = { value: 100, type: 'float', min: 10, max: 1000, unit: 'ms' };
        MOCK_PARAMS[`ch.${i}.gate.threshold`] = { value: -40, type: 'float', min: -80, max: 0, unit: 'dB' };
        MOCK_PARAMS[`ch.${i}.pan`] = { value: 0, type: 'float', min: -100, max: 100 };
        // 6 mix sends per channel
        for (let j = 0; j < 6; j++) {
            MOCK_PARAMS[`ch.${i}.mix.${j}.lvl`] = { value: -90, type: 'float', min: -90, max: 10, unit: 'dB' };
            MOCK_PARAMS[`ch.${i}.mix.${j}.on`] = { value: false, type: 'bool' };
        }
    }
    
    // 8 buses
    for (let i = 0; i < 8; i++) {
        MOCK_PARAMS[`bus.${i}.mix.lvl`] = { value: -10, type: 'float', min: -90, max: 10, unit: 'dB' };
        MOCK_PARAMS[`bus.${i}.mix.mute`] = { value: false, type: 'bool' };
        MOCK_PARAMS[`bus.${i}.pan`] = { value: 0, type: 'float', min: -100, max: 100 };
    }
    
    // 4 matrices
    for (let i = 0; i < 4; i++) {
        MOCK_PARAMS[`matrix.${i}.mix.lvl`] = { value: -10, type: 'float', min: -90, max: 10, unit: 'dB' };
        MOCK_PARAMS[`matrix.${i}.mix.mute`] = { value: false, type: 'bool' };
    }
    
    // 4 mains (stereo pairs)
    for (let i = 0; i < 4; i++) {
        MOCK_PARAMS[`main.${i}.mix.lvl`] = { value: -10, type: 'float', min: -90, max: 10, unit: 'dB' };
        MOCK_PARAMS[`main.${i}.mix.mute`] = { value: false, type: 'bool' };
    }
    
    // 16 DCAs
    for (let i = 0; i < 16; i++) {
        MOCK_PARAMS[`dca.${i}.mix.lvl`] = { value: 0.75, type: 'float', min: 0, max: 1, unit: 'normalized' };
        MOCK_PARAMS[`dca.${i}.mix.mute`] = { value: false, type: 'bool' };
    }
    
    // Scenes
    for (let i = 0; i < 100; i++) {
        MOCK_PARAMS[`scene.${i}.name`] = { value: `Scene ${i + 1}`, type: 'string' };
    }
    MOCK_PARAMS['scene.current'] = { value: 0, type: 'int', min: 0, max: 99 };
}

// Parse query parameters
function parseQuery(url) {
    const params = {};
    const queryString = url.split('?')[1];
    if (queryString) {
        queryString.split('&').forEach(param => {
            const [key, value] = param.split('=');
            params[decodeURIComponent(key)] = decodeURIComponent(value || '');
        });
    }
    return params;
}

// HTTP server
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const query = parseQuery(req.url);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // App state
    if (url === '/app/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            msg: '',
            progress: 0,
            state: 'connected',
            topState: 'connected'
        }));
        return;
    }
    
    // Console data - list all parameters
    if (url === '/console/data' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ params: MOCK_PARAMS }));
        return;
    }
    
    // Get specific parameter
    if (url.startsWith('/console/data/') && req.method === 'GET') {
        const paramPath = url.substring('/console/data/'.length);
        const param = MOCK_PARAMS[paramPath];
        if (param) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: paramPath, value: param.value, ...param }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Parameter not found: ${paramPath}` }));
        }
        return;
    }
    
    // Set parameter
    if (url.startsWith('/console/data/') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const paramPath = url.substring('/console/data/'.length);
                const data = JSON.parse(body);
                if (MOCK_PARAMS[paramPath]) {
                    MOCK_PARAMS[paramPath].value = data.value;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, path: paramPath, value: data.value }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Parameter not found: ${paramPath}` }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // Subscribe to parameter updates
    if (url === '/console/data/subscribe' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const clientId = data.clientId || 'default';
                SUBSCRIBERS[clientId] = data.paths || [];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, subscribed: SUBSCRIBERS[clientId] }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // Scene list
    if (url === '/console/scenes' && req.method === 'GET') {
        const scenes = [];
        for (let i = 0; i < 100; i++) {
            scenes.push({ id: i, name: MOCK_PARAMS[`scene.${i}.name`].value });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ scenes }));
        return;
    }
    
    // Scene recall
    if (url === '/console/scenes/recall' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                MOCK_PARAMS['scene.current'].value = data.sceneId;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, sceneId: data.sceneId }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // Metering
    if (url === '/console/metering/subscribe' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                // Return mock metering data
                const metering = {};
                for (let i = 0; i < 32; i++) {
                    metering[`ch.${i}.lvl`] = { left: -20 + Math.random() * 30, right: -20 + Math.random() * 30 };
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, metering }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // Default - 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Not found: ${url}` }));
});

// Initialize mock parameters
generateMockParams();

// Start server
const PORT = 8081;
server.listen(PORT, () => {
    console.log(`Mock Mixing Station API running on http://localhost:${PORT}`);
    console.log(`Parameters: ${Object.keys(MOCK_PARAMS).length}`);
    console.log('Endpoints:');
    console.log('  GET  /app/state');
    console.log('  GET  /console/data');
    console.log('  GET  /console/data/{path}');
    console.log('  POST /console/data/{path}');
    console.log('  POST /console/data/subscribe');
    console.log('  GET  /console/scenes');
    console.log('  POST /console/scenes/recall');
    console.log('  POST /console/metering/subscribe');
});
