"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const serve_static_1 = __importDefault(require("serve-static"));
const path_1 = __importDefault(require("path"));
const raspberry_pi_camera_native_1 = __importDefault(require("raspberry-pi-camera-native"));
const FPS_TRANSITION = 23;
const serve = (0, serve_static_1.default)(path_1.default.join(__dirname, '../www'));
let lastFrame;
const defaults = {
    width: 1920 / 2,
    height: 1080 / 2,
    fps: 25,
    encoding: 'JPEG',
    quality: 7 //32
};
const options = { ...defaults };
(0, http_1.createServer)(async (req, res) => {
    try {
        switch (req.url) {
            case '/photo':
                await raspberry_pi_camera_native_1.default.setConfig({ ...options, quality: 90 });
                raspberry_pi_camera_native_1.default.once('frame', async (frameData) => {
                    console.log(req.url, "frame", frameData.length);
                    await raspberry_pi_camera_native_1.default.setConfig(options);
                    res.writeHead(200, {
                        'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
                        Pragma: 'no-cache',
                        Connection: 'close',
                        'Content-Type': 'image/jpeg',
                        'Content-length': frameData.length
                    });
                    res.write(frameData);
                    res.end();
                });
                return;
            case '/lastframe':
                console.log(req.url, "frame", lastFrame.length);
                res.writeHead(200, {
                    'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
                    Pragma: 'no-cache',
                    Connection: 'close',
                    'Content-Type': 'image/jpeg',
                    'Content-length': lastFrame.length
                });
                res.write(lastFrame);
                res.end();
                return;
            case '/preview':
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
                    if (!frameSent) {
                        if (++dropped > FPS_TRANSITION) {
                            options.quality = Math.floor(options.quality * 0.9);
                            if (raspberry_pi_camera_native_1.default.listenerCount('frame') > 0) {
                                passed = 0;
                                dropped = 0;
                                console.log(req.url, "frame-", frameData.length);
                                await raspberry_pi_camera_native_1.default.setConfig(options);
                            }
                        }
                        return;
                    }
                    if (++passed > dropped + FPS_TRANSITION) {
                        options.quality += 1;
                        if (raspberry_pi_camera_native_1.default.listenerCount('frame') > 0) {
                            passed = 0;
                            dropped = 0;
                            console.log(req.url, "frame+", frameData.length);
                            await raspberry_pi_camera_native_1.default.setConfig(options);
                        }
                    }
                    try {
                        frameSent = false;
                        res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
                        res.write(frameData, () => frameSent = true);
                    }
                    catch (ex) {
                        console.log('Unable to send frame', ex);
                    }
                };
                if (lastFrame)
                    frameHandler(lastFrame);
                raspberry_pi_camera_native_1.default.on('frame', frameHandler);
                if (raspberry_pi_camera_native_1.default.listenerCount('frame') === 1)
                    await raspberry_pi_camera_native_1.default.resume();
                req.on('close', async () => {
                    raspberry_pi_camera_native_1.default.removeListener('frame', frameHandler);
                    if (raspberry_pi_camera_native_1.default.listenerCount('frame') === 0) {
                        await raspberry_pi_camera_native_1.default.pause();
                        options.quality = defaults.quality;
                        raspberry_pi_camera_native_1.default.setConfig(options);
                    }
                });
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
        res.end();
    }
}).listen(8000, () => {
    raspberry_pi_camera_native_1.default.start(defaults);
    raspberry_pi_camera_native_1.default.pause();
    console.log('Listening');
});
