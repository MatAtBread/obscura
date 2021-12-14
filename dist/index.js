"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const url_1 = require("url");
const promises_1 = require("fs/promises");
const fs_1 = require("fs");
const serve_static_1 = __importDefault(require("serve-static"));
const path_1 = __importDefault(require("path"));
const pi_camera_native_ts_1 = __importDefault(require("pi-camera-native-ts"));
const binary_search_1 = __importDefault(require("binary-search"));
const child_process_1 = require("child_process");
// Configurable values
const FPS_TRANSITION = 30; // Threshold of dropped/extra frames before the preview algorithm changes quality
const PHOTO_QUALITY = 90; // Quality for downloaded photo images
const TIMELAPSE_QUALITY = 15; // Quality of timelapse images
const TIMELAPSE_FPS = 10; // Target FPS for timelapse playback
const TIMELAPSE_SPEED = 600; // Default: 10 minutes -> 1 second (or 1 hour=>6 seconds, 1 day=>2m24s)
const TIMELAPSE_INTERVAL = 60; // Record one frame per minute (value in seconds)
const PORT = 8000;
const defaults = {
    width: 1920,
    height: 1080,
    fps: 20,
    encoding: 'JPEG',
    quality: 7
};
// Pre-calculated constants
const timelapseDir = path_1.default.join(__dirname, '../www/timelapse/');
const wwwStatic = (0, serve_static_1.default)(path_1.default.join(__dirname, '../www'));
let lastFrame;
let timeIndex = [];
let nextTimelapse = Math.floor(Date.now() / 1000);
const options = { ...defaults };
function sleep(seconds) {
    if (seconds > 0)
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return Promise.resolve();
}
function write(res, data) {
    return new Promise(resolve => res.write(data, resolve));
}
async function handleHttpRequest(req, res) {
    try {
        const url = new url_1.URL("http://server" + req.url);
        const qs = url.searchParams;
        switch (url.pathname) {
            case '/deploy':
            case '/deploy/':
                res.write("ok");
                res.end();
                console.log("Re-deploying");
                const p = (0, child_process_1.exec)('npm run deploy');
                p.stdout?.pipe(process.stdout);
                p.stderr?.pipe(process.stderr);
                return;
            case '/photo':
            case '/photo/':
                sendFrame(res, await takePhoto(Number(qs.get('q') || PHOTO_QUALITY)));
                return;
            case '/timelapse':
            case '/timelapse/':
                await streamTimelapse(req, res, {
                    fps: Number(qs.get('fps') || TIMELAPSE_FPS),
                    since: Number(qs.get('since')) || undefined,
                    speed: Number(qs.get('speed') || TIMELAPSE_SPEED)
                });
                return;
            case '/lastframe':
            case '/lastframe/':
                if (!lastFrame)
                    throw new Error("Camera not started");
                sendFrame(res, lastFrame);
                return;
            case '/preview':
            case '/preview/':
                await streamPreview(req, res);
                return;
            case '/':
                req.url = "/index.html";
                break;
        }
        if (!req.url || req.url.indexOf('..') >= 0)
            throw new Error('Not found');
        wwwStatic(req, res, () => {
            res.statusCode = 404;
            res.write("Not found");
            res.end();
        });
    }
    catch (ex) {
        res.statusCode = 500;
        if (ex)
            res.write('message' in ex ? ex.message : ex.toString());
        res.end();
    }
}
function sendFrame(res, frameData) {
    res.writeHead(200, {
        'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
        Pragma: 'no-cache',
        Connection: 'close',
        'Content-Type': 'image/jpeg',
        'Content-length': frameData.length
    });
    res.write(frameData);
    res.end();
}
async function streamPreview(req, res) {
    res.writeHead(200, {
        'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
        Pragma: 'no-cache',
        Connection: 'close',
        'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
    });
    let frameSent = true;
    let dropped = 0;
    let passed = 0;
    const previewFrame = async (frameData) => {
        lastFrame = frameData;
        try {
            if (!frameSent) {
                if (++dropped > FPS_TRANSITION) {
                    options.quality = Math.max(2, Math.floor(options.quality * 0.8));
                    if (pi_camera_native_ts_1.default.listenerCount('frame') > 0) {
                        passed = 0;
                        dropped = 0;
                        console.log("frame-", frameData.length, options.quality);
                        await pi_camera_native_ts_1.default.setConfig(options);
                    }
                }
                return;
            }
            if (++passed > dropped + FPS_TRANSITION) {
                options.quality += 1;
                if (pi_camera_native_ts_1.default.listenerCount('frame') > 0) {
                    passed = 0;
                    dropped = 0;
                    console.log("frame+", frameData.length, options.quality);
                    await pi_camera_native_ts_1.default.setConfig(options);
                }
            }
        }
        catch (e) {
            console.warn("Failed to change quality", e);
        }
        try {
            frameSent = false;
            res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
            await write(res, frameData);
            frameSent = true;
        }
        catch (ex) {
            console.warn('Unable to send frame', ex);
        }
        finally {
        }
    };
    if (lastFrame)
        previewFrame(lastFrame);
    pi_camera_native_ts_1.default.on('frame', previewFrame);
    if (pi_camera_native_ts_1.default.listenerCount('frame') === 1)
        await pi_camera_native_ts_1.default.start(options); //await camera.resume();
    req.once('close', async () => {
        res.end();
        pi_camera_native_ts_1.default.removeListener('frame', previewFrame);
        if (pi_camera_native_ts_1.default.listenerCount('frame') === 0) {
            if (options.quality < defaults.quality)
                options.quality = defaults.quality;
            //await camera.setConfig(options);
            //await camera.pause();
            await pi_camera_native_ts_1.default.stop();
        }
    });
}
async function streamTimelapse(req, res, { fps, speed, since }) {
    res.writeHead(200, {
        'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
        Pragma: 'no-cache',
        Connection: 'close',
        'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
    });
    try {
        let closed = false;
        req.once('close', () => closed = true);
        if (speed < 0) {
            throw new Error("Not yet implemented");
        }
        else {
            let frameIndex = (0, binary_search_1.default)(timeIndex, since || 0, (t, n) => t.time - n);
            if (frameIndex < 0)
                frameIndex = ~frameIndex;
            while (!closed) {
                let time = (Date.now() / 1000);
                // Send a frame to the client
                const frame = timeIndex[frameIndex];
                res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frame.size}\n\n`);
                await write(res, await (0, promises_1.readFile)(timelapseDir + frame.name));
                // Having written the first frame, we'll want to send another one in T+1/fps in real time.
                // which is T+speed/fps in timelapse time. 
                let nextFrameIndex = (0, binary_search_1.default)(timeIndex, frame.time + speed / fps || 0, (t, n) => t.time - n);
                if (nextFrameIndex < 0)
                    nextFrameIndex = ~nextFrameIndex;
                if (nextFrameIndex === frameIndex)
                    nextFrameIndex += 1;
                // Check we've not run out of frames
                if (nextFrameIndex >= timeIndex.length)
                    return sendFrame(res, await (0, promises_1.readFile)(timelapseDir + timeIndex[timeIndex.length - 1].name));
                // Sleep until the actual time the next frame is due. If that's negative, skip extra frames until we can sleep
                const deviation = (Date.now() / 1000 - time);
                let d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
                while (d < deviation) {
                    nextFrameIndex += 1;
                    if (nextFrameIndex >= timeIndex.length)
                        return sendFrame(res, await (0, promises_1.readFile)(timelapseDir + timeIndex[timeIndex.length - 1].name));
                    d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
                }
                await sleep(d - deviation);
                frameIndex = nextFrameIndex;
            }
        }
    }
    catch (ex) {
        console.warn("Timelapse", ex);
    }
    finally {
        res.end();
    }
}
async function takePhoto(quality = PHOTO_QUALITY) {
    if (!pi_camera_native_ts_1.default.running) {
        await pi_camera_native_ts_1.default.start({ ...options, quality: quality });
        await sleep(1); // Wait for camaera to do AWB and Exposure control
        const frameData = await pi_camera_native_ts_1.default.nextFrame();
        await sleep(0.1);
        await pi_camera_native_ts_1.default.stop();
        return frameData;
    }
    else {
        await pi_camera_native_ts_1.default.setConfig({ ...options, quality: quality });
        await pi_camera_native_ts_1.default.nextFrame();
        const frameData = await pi_camera_native_ts_1.default.nextFrame();
        await pi_camera_native_ts_1.default.setConfig(options);
        return frameData;
    }
}
async function saveTimelapse() {
    // init timelapse index
    try {
        const timelapseIndex = (0, fs_1.readFileSync)(timelapseDir + "state.ndjson").toString();
        timeIndex = timelapseIndex.split(/\n|\n\r|\r\n/).map(r => {
            try {
                return JSON.parse(r);
            }
            catch (e) {
                return undefined;
            }
        }).filter(o => o && typeof o.time === 'number' && typeof o.name === 'string');
    }
    catch (e) {
        console.warn("Timelapse index", e);
    }
    console.log("Timelapse index length", timeIndex.length);
    while (true) {
        try {
            nextTimelapse += TIMELAPSE_INTERVAL;
            const photo = lastFrame = await takePhoto(TIMELAPSE_QUALITY);
            const now = new Date();
            const path = String(now.getUTCFullYear()) + '_'
                + String(now.getMonth() + 1).padStart(2, '0') + '_'
                + String(now.getUTCDate()).padStart(2, '0');
            await (0, promises_1.mkdir)(timelapseDir + path, { recursive: true });
            const frameName = path + '/'
                + String(now.getHours()).padStart(2, '0') + '_'
                + String(now.getMinutes()).padStart(2, '0') + '_'
                + String(now.getSeconds()).padStart(2, '0') + '.jpg';
            await (0, promises_1.writeFile)(timelapseDir + frameName, photo);
            const entry = {
                name: frameName,
                size: photo.length,
                time: Math.floor(now.getTime() / 1000)
            };
            await (0, promises_1.appendFile)(timelapseDir + "state.ndjson", JSON.stringify(entry) + "\n");
            timeIndex.push(entry);
        }
        catch (e) {
            console.warn("Failed to take timelapse photo", e);
        }
        await sleep(nextTimelapse - Date.now() / 1000);
    }
}
(0, http_1.createServer)(handleHttpRequest).listen(PORT, async () => {
    console.log('Listening on port ' + PORT);
    saveTimelapse();
});
