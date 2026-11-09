const WebSocket = require('ws');

// Mock Mixing Station WebSocket API
// Simulates a Behringer X32 mixer with 32 channels, 8 buses, 4 matrices, 4 mains, 16 DCAs

const MOCK_PARAMS = {};

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

// Create WebSocket server
// 8080: the same port the server defaults to, so `node mock/...` then `npm start` works.
const wss = new WebSocket.Server({ port: 8080 });

console.log('Mock Mixing Station WebSocket API starting on port 8080...');

wss.on('connection', (ws) => {
    console.log('Client connected');
    
    ws.on('message', (data) => {
        try {
            const request = JSON.parse(data.toString());
            console.log('Request:', request);
            
            // Handle different request types
            if (request.path === '/console/data' && request.method === 'GET') {
                // List all parameters
                ws.send(JSON.stringify({
                    path: request.path,
                    method: request.method,
                    body: { params: MOCK_PARAMS },
                    error: null
                }));
            } else if (request.path.startsWith('/console/data/') && request.method === 'GET') {
                // Get specific parameter
                const paramPath = request.path.substring('/console/data/'.length);
                const param = MOCK_PARAMS[paramPath];
                if (param) {
                    ws.send(JSON.stringify({
                        path: request.path,
                        method: request.method,
                        body: { path: paramPath, value: param.value, ...param },
                        error: null
                    }));
                } else {
                    ws.send(JSON.stringify({
                        path: request.path,
                        method: request.method,
                        body: null,
                        error: `Parameter not found: ${paramPath}`
                    }));
                }
            } else if (request.path.startsWith('/console/data/') && request.method === 'POST') {
                // Set parameter
                const paramPath = request.path.substring('/console/data/'.length);
                if (MOCK_PARAMS[paramPath]) {
                    MOCK_PARAMS[paramPath].value = request.body.value;
                    ws.send(JSON.stringify({
                        path: request.path,
                        method: request.method,
                        body: { success: true, path: paramPath, value: request.body.value },
                        error: null
                    }));
                } else {
                    ws.send(JSON.stringify({
                        path: request.path,
                        method: request.method,
                        body: null,
                        error: `Parameter not found: ${paramPath}`
                    }));
                }
            } else if (request.path === '/console/data/subscribe' && request.method === 'POST') {
                // Subscribe to parameter updates
                ws.send(JSON.stringify({
                    path: request.path,
                    method: request.method,
                    body: { success: true, subscribed: request.body.paths || [] },
                    error: null
                }));
            } else if (request.path === '/console/scenes' && request.method === 'GET') {
                // List scenes
                const scenes = [];
                for (let i = 0; i < 100; i++) {
                    scenes.push({ id: i, name: MOCK_PARAMS[`scene.${i}.name`].value });
                }
                ws.send(JSON.stringify({
                    path: request.path,
                    method: request.method,
                    body: { scenes },
                    error: null
                }));
            } else if (request.path === '/console/scenes/recall' && request.method === 'POST') {
                // Recall scene
                MOCK_PARAMS['scene.current'].value = request.body.sceneId;
                ws.send(JSON.stringify({
                    path: request.path,
                    method: request.method,
                    body: { success: true, sceneId: request.body.sceneId },
                    error: null
                }));
            } else {
                ws.send(JSON.stringify({
                    path: request.path,
                    method: request.method,
                    body: null,
                    error: `Not found: ${request.path}`
                }));
            }
        } catch (e) {
            console.error('Error processing request:', e);
            ws.send(JSON.stringify({
                path: request.path,
                method: request.method,
                body: null,
                error: e.message
            }));
        }
    });
    
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// Initialize mock parameters
generateMockParams();

console.log(`Mock Mixing Station WebSocket API running on ws://localhost:8080`);
console.log(`Parameters: ${Object.keys(MOCK_PARAMS).length}`);
