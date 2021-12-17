"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const url_1 = require("url");
const promises_1 = require("fs/promises");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const serve_static_1 = __importDefault(require("serve-static"));
const pi_camera_native_ts_1 = __importStar(require("pi-camera-native-ts"));
const binary_search_1 = __importDefault(require("binary-search"));
const helpers_1 = require("./helpers");
const admin_1 = require("./admin");
// Configurable values
const FPS_TRANSITION = 30; // Threshold of dropped/extra frames before the preview algorithm changes quality
const PHOTO_QUALITY = 90; // Quality for downloaded photo images
const DEFAULT_QUALITY = 12;
const MINIMUM_QUALITY = 5;
const PORT = 8000;
const CONFIG_VERSION = 1;
let config;
const configPath = path_1.default.join(__dirname, '../config/config.json');
try {
    config = require(configPath);
    if (config?.version !== CONFIG_VERSION || config?.camera?.encoding !== 'JPEG') {
        throw new Error("Invalid config");
    }
}
catch (ex) {
    config = {
        version: 1,
        landscape: true,
        camera: {
            width: 1920,
            height: 1080,
            fps: 20,
            encoding: 'JPEG',
            quality: DEFAULT_QUALITY,
            rotation: 0,
            mirror: pi_camera_native_ts_1.Mirror.NONE
        },
        timelapse: {
            quality: DEFAULT_QUALITY,
            speed: 14400,
            intervalSeconds: 300 // Record one frame every 5 minutes (value in seconds)  
        }
    };
}
// Configurable constants
function cameraConfig(overrides = {}) {
    const r = { ...config.camera, ...overrides };
    if (!config.landscape) {
        const swap = r.width;
        r.width = r.height;
        r.height = swap;
    }
    return r;
}
// Pre-calculated constants
const timelapseDir = path_1.default.join(__dirname, '../www/timelapse/');
const wwwStatic = (0, serve_static_1.default)(path_1.default.join(__dirname, '../www'), {
    maxAge: 3600000
});
// Other singleton variables
let previewQuality = config.camera.quality; // Dynamically modified quality
let lastFrame;
let timeIndex = [];
pi_camera_native_ts_1.default.on('frame', frame => lastFrame = frame);
async function handleHttpRequest(req, res) {
    try {
        const url = new url_1.URL("http://server" + req.url);
        const qs = url.searchParams;
        switch (url.pathname) {
            case '/settings':
            case '/settings/':
                if (qs.has("rotate"))
                    config.camera.rotation = (config.camera.rotation + 90) % 360;
                if (qs.has("hmirror"))
                    config.camera.mirror = config.camera.mirror ^ pi_camera_native_ts_1.Mirror.HORZ;
                if (qs.has("vmirror"))
                    config.camera.mirror = config.camera.mirror ^ pi_camera_native_ts_1.Mirror.VERT;
                if (qs.has("landscape"))
                    config.landscape = !config.landscape;
                if (pi_camera_native_ts_1.default.running) {
                    // For some reason changing flip while the camera is running fails, so 
                    // we have to stop/start it rather than use setConfig.
                    // Since rotate updates the frame size, we have to restart the camera
                    await pi_camera_native_ts_1.default.stop();
                    await pi_camera_native_ts_1.default.start(cameraConfig({ quality: previewQuality }));
                    await (0, helpers_1.sleep)(0.1);
                }
                sendInfo(res);
                await (0, promises_1.writeFile)(configPath, JSON.stringify(config));
                return;
            case '/at.jpg':
                const t = qs.has('t') ? new Date(Number(qs.get('t') || 0)) : undefined;
                let frameIndex = (0, binary_search_1.default)(timeIndex, (t ? t.getTime() / 1000 : 0), (t, n) => t.time - n);
                if (frameIndex < 0)
                    frameIndex = ~frameIndex;
                if (frameIndex >= timeIndex.length)
                    frameIndex = timeIndex.length - 1;
                res.setHeader("Location", `/timelapse/${timeIndex[frameIndex].name}`);
                res.writeHead(302);
                res.end();
                return;
            case '/info':
            case '/info/':
                sendInfo(res);
                return;
            case '/admin/redeploy':
            case '/admin/redeploy/':
                (0, admin_1.redeploy)(res);
                return;
            case '/admin/build-state':
            case '/admin/build-state/':
                const newIndex = await (0, admin_1.createStateFromFileSystem)(timelapseDir);
                // We do a sync write to ensure the file can't be appended to in mid-write
                (0, fs_1.writeFileSync)(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"));
                timeIndex = newIndex;
                res.write(`Complete. ${timeIndex.length} frames loaded`);
                res.end();
                return;
            case '/photo':
            case '/photo/':
                sendFrame(res, await takePhoto(Number(qs.get('q') || PHOTO_QUALITY)));
                return;
            case '/timelapse':
            case '/timelapse/':
                sendMJPEGHeaders(res);
                await streamTimelapse(req, res, {
                    fps: Number(qs.get('fps') || config.camera.fps),
                    since: qs.has('since') ? new Date(Number(qs.get('since') || 0)) : undefined,
                    speed: Number(qs.get('speed') || config.timelapse.speed)
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
                sendMJPEGHeaders(res);
                await streamPreview(req, res);
                return;
        }
        if (!req.url || req.url.indexOf('..') >= 0)
            throw new Error('Not found');
        if (req.url.endsWith('/'))
            req.url += "index.html";
        wwwStatic(req, res, () => {
            res.statusCode = 404;
            res.write("Not found: " + req.url);
            res.end();
        });
    }
    catch (ex) {
        console.warn("Request", req.url, ex);
        res.statusCode = 500;
        if (ex)
            res.write('message' in ex ? ex.message : ex.toString());
        res.end();
    }
}
function sendInfo(res) {
    res.setHeader("Content-type", "application/json");
    res.write(JSON.stringify({
        previewQuality,
        totalFrameSize: timeIndex.reduce((a, b) => a + b.size, 0),
        countFrames: timeIndex.length,
        startFrame: timeIndex[0]?.time || new Date(timeIndex[0].time * 1000),
        config
    }));
    res.end();
}
function sendMJPEGHeaders(res) {
    res.writeHead(200, {
        'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
        Pragma: 'no-cache',
        Connection: 'close',
        'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
    });
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
    let frameSent = true;
    let dropped = 0;
    let passed = 0;
    const previewFrame = async (frameData) => {
        try {
            if (!frameSent) {
                if (++dropped > FPS_TRANSITION) {
                    previewQuality = Math.max(MINIMUM_QUALITY, Math.floor(previewQuality * 0.8));
                    if (pi_camera_native_ts_1.default.listenerCount('frame') > 1) {
                        passed = 0;
                        dropped = 0;
                        //console.log("frame-", frameData.length, previewQuality);
                        await pi_camera_native_ts_1.default.setConfig(cameraConfig({ quality: previewQuality }));
                    }
                }
                return;
            }
            if (++passed > dropped + FPS_TRANSITION) {
                previewQuality += 1;
                if (pi_camera_native_ts_1.default.listenerCount('frame') > 1) {
                    passed = 0;
                    dropped = 0;
                    //console.log("frame+", frameData.length, previewQuality);
                    await pi_camera_native_ts_1.default.setConfig(cameraConfig({ quality: previewQuality }));
                }
            }
        }
        catch (e) {
            console.warn("Failed to change quality", e);
        }
        try {
            frameSent = false;
            res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
            await (0, helpers_1.write)(res, frameData);
            frameSent = true;
        }
        catch (ex) {
            console.warn('Unable to send frame', ex);
        }
    };
    if (lastFrame)
        previewFrame(lastFrame);
    pi_camera_native_ts_1.default.on('frame', previewFrame);
    if (pi_camera_native_ts_1.default.listenerCount('frame') === 2)
        await pi_camera_native_ts_1.default.start(cameraConfig({ quality: previewQuality }));
    req.once('close', async () => {
        res.end();
        pi_camera_native_ts_1.default.removeListener('frame', previewFrame);
        if (pi_camera_native_ts_1.default.listenerCount('frame') === 1) {
            await pi_camera_native_ts_1.default.stop();
        }
    });
}
async function streamTimelapse(req, res, { fps, speed, since }) {
    let closed = false;
    req.once('close', () => closed = true);
    if (speed < 0) {
        throw new Error("Not yet implemented");
    }
    else {
        let frameIndex = (0, binary_search_1.default)(timeIndex, (since ? since.getTime() / 1000 : 0), (t, n) => t.time - n);
        if (frameIndex < 0)
            frameIndex = ~frameIndex;
        while (!closed) {
            let time = (Date.now() / 1000);
            // Send a frame to the client
            const frame = timeIndex[frameIndex];
            res.write(`--myboundary; id=${frame.time}\nContent-Type: image/jpg\nContent-length: ${frame.size}\n\n`);
            await (0, helpers_1.write)(res, await (0, promises_1.readFile)(timelapseDir + frame.name));
            // Having written the first frame, we'll want to send another one in T+1/fps in real time.
            // which is T+speed/fps in timelapse time. 
            let nextFrameIndex = (0, binary_search_1.default)(timeIndex, frame.time + speed / fps || 0, (t, n) => t.time - n);
            if (nextFrameIndex < 0)
                nextFrameIndex = ~nextFrameIndex;
            if (nextFrameIndex === frameIndex)
                nextFrameIndex += 1;
            // Check we've not run out of frames
            if (nextFrameIndex >= timeIndex.length) {
                const finalFrame = await (0, promises_1.readFile)(timelapseDir + timeIndex[timeIndex.length - 1].name);
                res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${finalFrame.length}\n\n`);
                res.write(finalFrame);
                res.end();
                return;
            }
            // Sleep until the actual time the next frame is due. If that's negative, skip extra frames until we can sleep
            const deviation = (Date.now() / 1000 - time);
            let d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
            while (d < deviation && !closed) {
                nextFrameIndex += 1;
                if (nextFrameIndex >= timeIndex.length) {
                    const finalFrame = await (0, promises_1.readFile)(timelapseDir + timeIndex[timeIndex.length - 1].name);
                    res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${finalFrame.length}\n\n`);
                    res.write(finalFrame);
                    res.end();
                    return;
                }
                d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
            }
            await (0, helpers_1.sleep)(d - deviation);
            frameIndex = nextFrameIndex;
        }
    }
}
async function takePhoto(quality = PHOTO_QUALITY) {
    if (!pi_camera_native_ts_1.default.running) {
        await pi_camera_native_ts_1.default.start(cameraConfig({ quality }));
        await (0, helpers_1.sleep)(1); // Wait for camaera to do AWB and Exposure control
        const frameData = await pi_camera_native_ts_1.default.nextFrame();
        await (0, helpers_1.sleep)(0.1);
        await pi_camera_native_ts_1.default.stop();
        return frameData;
    }
    else {
        await pi_camera_native_ts_1.default.setConfig(cameraConfig({ quality }));
        await pi_camera_native_ts_1.default.nextFrame();
        const frameData = await pi_camera_native_ts_1.default.nextFrame();
        await pi_camera_native_ts_1.default.setConfig(cameraConfig({ quality: previewQuality }));
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
    if (timeIndex.length === 0) {
        console.log("Timelapse index missing or unreadable");
        // Check the file system for images
        const newIndex = await (0, admin_1.createStateFromFileSystem)(timelapseDir);
        // We do a sync write to ensure the file can't be appended to in mid-write
        (0, fs_1.writeFileSync)(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"));
        timeIndex = newIndex;
    }
    console.log("Timelapse index length", timeIndex.length);
    let nextTimelapse = Math.floor(Date.now() / 1000);
    while (true) {
        try {
            nextTimelapse += config.timelapse.intervalSeconds;
            const photo = await takePhoto(config.timelapse.quality);
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
        await (0, helpers_1.sleep)(nextTimelapse - Date.now() / 1000);
    }
}
(0, http_1.createServer)(handleHttpRequest).listen(PORT, async () => {
    console.log(`Verison ${require('../package.json').version}: listening on port ${PORT}`);
    saveTimelapse();
});
