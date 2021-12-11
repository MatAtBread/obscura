"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const url_1 = require("url");
const promises_1 = require("fs/promises");
const serve_static_1 = __importDefault(require("serve-static"));
const path_1 = __importDefault(require("path"));
const pi_camera_native_ts_1 = __importDefault(require("pi-camera-native-ts"));
const FPS_TRANSITION = 20;
const PHOTO_QUALITY = 90;
const TIMELAPSE_QUALITY = 20;
const TIMELAPSE_FPS = 10;
const timelapseDir = path_1.default.join(__dirname, '../www/timelapse/');
const port = 8000;
const serve = (0, serve_static_1.default)(path_1.default.join(__dirname, '../www'));
let lastFrame;
const defaults = {
    width: 1920,
    height: 1080,
    fps: 20,
    encoding: 'JPEG',
    quality: 7 //32
};
const options = { ...defaults };
function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}
(0, http_1.createServer)(async (req, res) => {
    try {
        const url = new url_1.URL("http://server" + req.url);
        const qs = url.searchParams || {};
        switch (url.pathname) {
            case '/photo':
            case '/photo/':
                const frameData = await takePhoto();
                sendFrame(frameData);
                return;
            case '/timelapse':
            case '/timelapse/':
                await streamTimelapse({
                    fps: Number(qs.get('fps') || TIMELAPSE_FPS),
                    since: Number(qs.get('fps') || 0),
                    speed: Number(qs.get('speed') || 1),
                    reverse: qs.has('reverse')
                });
                return;
            case '/lastframe':
            case '/lastframe/':
                sendFrame(lastFrame);
                return;
            case '/preview':
            case '/preview/':
                await streamPreview();
                return;
        }
        serve(req, res, () => {
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
    function sendFrame(frameData) {
        console.log("\n" + req.url, "frame", frameData.length, PHOTO_QUALITY);
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
    async function streamPreview() {
        res.writeHead(200, {
            'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
            Pragma: 'no-cache',
            Connection: 'close',
            'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
        });
        let frameSent = true;
        let dropped = 0;
        let passed = 0;
        const frameHandler = async (frameData) => {
            lastFrame = frameData;
            try {
                if (!frameSent) {
                    if (++dropped > FPS_TRANSITION) {
                        options.quality = Math.floor(options.quality * 0.876);
                        if (pi_camera_native_ts_1.default.listenerCount('frame') > 0) {
                            passed = 0;
                            dropped = 0;
                            console.log(req.url, "frame-", frameData.length, options.quality);
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
                        console.log("\n" + req.url, "frame+", frameData.length, options.quality);
                        await pi_camera_native_ts_1.default.setConfig(options);
                    }
                }
            }
            catch (e) {
                console.warn("\nFailed to change quality", e);
            }
            try {
                frameSent = false;
                res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
                res.write(frameData, () => frameSent = true);
            }
            catch (ex) {
                console.warn('\nUnable to send frame', ex);
            }
        };
        if (lastFrame)
            frameHandler(lastFrame);
        pi_camera_native_ts_1.default.on('frame', frameHandler);
        if (pi_camera_native_ts_1.default.listenerCount('frame') === 1)
            await pi_camera_native_ts_1.default.start(options); //await camera.resume();
        req.on('close', async () => {
            pi_camera_native_ts_1.default.removeListener('frame', frameHandler);
            sleep(1).then(() => {
                if (pi_camera_native_ts_1.default.listenerCount('frame') === 0) {
                    options.quality = defaults.quality;
                    //await camera.setConfig(options);
                    //await camera.pause();
                    return pi_camera_native_ts_1.default.stop();
                }
            });
        });
    }
    async function streamTimelapse({ fps, speed, reverse, since }) {
        res.writeHead(200, {
            'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
            Pragma: 'no-cache',
            Connection: 'close',
            'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
        });
        let nextFrameTime = Date.now();
        let photo;
        for (photo = reverse ? photoCount - 1 : 1; photo > 0; photo += speed * (reverse ? -1 : 1)) {
            nextFrameTime += (1000 / fps);
            const frameName = timelapseDir + photo + ".jpg";
            const info = await (0, promises_1.stat)(frameName);
            res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${info.size}\n\n`);
            res.write(await (0, promises_1.readFile)(frameName));
            const now = Date.now();
            if (now < nextFrameTime)
                await sleep((nextFrameTime - now) / 1000);
        }
        req.on('close', async () => photo = -1);
    }
}).listen(port, async () => {
    //await camera.start(defaults);
    //await camera.pause();
    console.log('Listening on port ' + port);
});
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
let photoCount;
try {
    const saved = require(timelapseDir + "state.json");
    photoCount = saved.photoCount;
    console.log("Timelapse series continue from ", photoCount);
}
catch (e) {
    console.log("No saved state, starting a new timelapse series");
    photoCount = 1;
}
setInterval(async () => {
    try {
        const photo = await takePhoto(TIMELAPSE_QUALITY);
        const frameName = timelapseDir + photoCount + ".jpg";
        await (0, promises_1.writeFile)(frameName, photo);
        photoCount += 1;
        await (0, promises_1.writeFile)(timelapseDir + "state.json", JSON.stringify({ photoCount }));
    }
    catch (e) {
        console.warn("Failed to take timelapse photo", e);
    }
}, 10000);
