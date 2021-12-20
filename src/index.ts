import { EventEmitter, Writable } from 'stream';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { writeFile, readFile, mkdir, appendFile, unlink } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

import serveStatic from 'serve-static';
import camera, { CameraOptions, Mirror } from 'pi-camera-native-ts';
import binarySearch from 'binary-search';

import { TimeIndex, TimeStamp } from './types';
import { sleep, write } from './helpers';
import { redeploy, createStateFromFileSystem } from './admin';

// Configurable values
const PHOTO_QUALITY = 90;       // Quality for downloaded photo images
const DEFAULT_QUALITY = 12;
const MINIMUM_QUALITY = 5;
const PORT = 8000;
const CONFIG_VERSION = 1;

let config : {
  version: 1,
  landscape: boolean,
  camera: CameraOptions,
  timelapse: {
    quality: number,
    speed: number,
    intervalSeconds: number
  }
};

const configPath = path.join(__dirname, '../config/config.json');
try {
  config = require(configPath);
  if (config?.version !== CONFIG_VERSION || config?.camera?.encoding !== 'JPEG') {
    throw new Error("Invalid config");
  }
} catch (ex) {
  config = {
    version: 1,
    landscape: true,
    camera:{
      width: 1920,
      height: 1080,
      fps: 20,
      encoding: 'JPEG',
      quality: DEFAULT_QUALITY,
      rotation: 0,
      mirror: Mirror.NONE
    },
    timelapse: {
      quality: DEFAULT_QUALITY,   // Quality of timelapse images
      speed: 14400,               // Default: 4 hours -> 1 second
      intervalSeconds: 300        // Record one frame every 5 minutes (value in seconds)  
    }
  } 
}

// Configurable constants
function cameraConfig(overrides: Partial<CameraOptions> = {}) {
  const r = {...config.camera, ...overrides};
  if (!config.landscape) {
    const swap = r.width;
    r.width = r.height;
    r.height = swap;
  }
  return r;
}

// Pre-calculated constants
const timelapseDir = path.join(__dirname, '../www/timelapse/');
const wwwStatic = serveStatic(path.join(__dirname, '../www'), {
  maxAge: 3600000,
  redirect: false
});

// Other singleton variables
let previewQuality = config.camera.quality;  // Dynamically modified quality
let timeIndex: Array<TimeIndex> = [];

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL("http://server" + req.url);
    const qs = url.searchParams;

    switch (url.pathname) {
      case '/settings':
      case '/settings/':
        if (qs.has("rotate"))
          config.camera.rotation = (config.camera.rotation + 90) % 360 as CameraOptions['rotation'];
        if (qs.has("hmirror"))
          config.camera.mirror = config.camera.mirror ^ Mirror.HORZ;
        if (qs.has("vmirror"))
          config.camera.mirror = config.camera.mirror ^ Mirror.VERT;
        if (qs.has("landscape"))
          config.landscape = !config.landscape;

        if (camera.running) {
          // For some reason changing flip while the camera is running fails, so 
          // we have to stop/start it rather than use setConfig.
          // Since rotate updates the frame size, we have to restart the camera
          await camera.stop();
          await camera.start(cameraConfig({ quality: previewQuality }));
          await sleep(0.1);
        }
        sendInfo(res);
        await writeFile(configPath, JSON.stringify(config));
        return;

      case '/at.jpg':
        const t = qs.has('t') ? new Date(Number(qs.get('t') || 0)) : undefined
        let frameIndex = binarySearch(timeIndex, (t ? t.getTime() / 1000 : 0) as TimeStamp, (t, n) => t.time - n);
        if (frameIndex < 0)
          frameIndex = ~frameIndex;
        if (frameIndex >= timeIndex.length)
          frameIndex = timeIndex.length-1;

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
        redeploy(res);
        return;

      case '/admin/build-state':
      case '/admin/build-state/':
        const newIndex = await createStateFromFileSystem(timelapseDir);
        // We do a sync write to ensure the file can't be appended to in mid-write
        writeFileSync(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"))
        timeIndex = newIndex;
        sendInfo(res);
        return;

      case '/admin/prune':
      case '/admin/prune/':
        const interval = Number(qs.has('interval') && qs.get('interval'));
        if (!interval || interval < config.timelapse.intervalSeconds)
          throw new Error("Invalid interval parameter");

        let removed = 0;
        let preserved = 0;
        let lastTime = 0;
        const tNew: TimeIndex[] = [];
        for (const t of timeIndex) {
          if (t.time - lastTime < interval) {
            removed += 1;
            await unlink(timelapseDir + t.name);
          } else {
            preserved += 1;
            tNew.push(t);
            lastTime = t.time;
          }
        }
        timeIndex = tNew;
        // We do a sync write to ensure the file can't be appended to in mid-write
        writeFileSync(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"))
        sendInfo(res, { preserved, removed });
        return;

      case '/photo':
      case '/photo/':
        sendFrame(res, await takePhoto(Number(qs.get('q') || PHOTO_QUALITY)));
        return;

      case '/timelapse':
      case '/timelapse/':
        if (qs.has("compress")) {
          // Warning: On a Pi Zero 2W, the maximum frame rate is around 5fps, even with H/W GPU support, so
          // although it does reduce the required bandwidth (in the command below, to 2Mb/s), the frame rate
          // is so reduced that MJPEG takes up approx 7-8Mb/s, which is well with the WiFi bandwidth of the
          // Pi Zero 2.

          // In any case (for example over a mobile phone, ssh, etc), both sendTimelapse & sendPreview will
          // drop frames to reduce buffering/latency, and in the case of sendPreview will also lower JPEG quality
          
          // This mechanism is also unsuitable for /preview/ as the latency is very high 
          const fps = Number(qs.has('fps') && qs.get('fps') || 5);
          let ffmpeg:ChildProcessWithoutNullStreams|undefined = spawn('ffmpeg',`-f mjpeg -r ${fps} -i - -f matroska -vcodec h264_omx -b:v 2M -zerocopy 1 -r ${fps} -`.split(' '))
          res.writeHead(200, {
            Connection: 'close',
            'Content-Type': 'video/x-matroska'
          });
          ffmpeg.stdout.pipe(res);
          ffmpeg.stderr.on('data', d => null).on('error', e => console.warn("ffmpeg",e));
          ffmpeg.once('close', () => ffmpeg = undefined);
          res.once('close', ()=> ffmpeg?.kill('SIGINT'));
          await streamTimelapse(ffmpeg, ffmpeg.stdin, {
            fast: true,
            fps,
            since: qs.has('since') ? new Date(Number(qs.get('since') || 0)) : undefined,
            speed: Number(qs.get('speed') || config.timelapse.speed)
          });
        } else {
          sendMJPEGHeaders(res);
          await streamTimelapse(req, res, {
            fps: Number(qs.get('fps') || config.camera.fps),
            since: qs.has('since') ? new Date(Number(qs.get('since') || 0)) : undefined,
            speed: Number(qs.get('speed') || config.timelapse.speed)
          });
        }
        return;

      case '/lastframe':
      case '/lastframe/':
        if (!camera.lastFrame)
          throw new Error("Camera not started");
        sendFrame(res, camera.lastFrame);
        return;

      case '/preview':
      case '/preview/':
        sendMJPEGHeaders(res);
        await streamPreview(req, res, Number(qs.get('fps') || config.camera.fps));
        return;
    }

    // Static resources
    if (!req.url || req.url.indexOf('..') >= 0)
      throw new Error('Not found');

    if (req.url.endsWith('/'))
      req.url += "index.html";

    wwwStatic(req, res, () => {
      res.statusCode = 404;
      res.write("Not found: " + req.url);
      res.end();
    });
  } catch (ex: any) {
    console.warn("Request",req.url,ex);
    res.statusCode = 500;
    if (ex)
      res.write('message' in ex ? ex.message : ex.toString());
    res.end();
  }
}

function sendInfo<MoreInfo extends {}>(res: ServerResponse, moreInfo?: MoreInfo) {
  res.setHeader("Content-type", "application/json");
  res.write(JSON.stringify({
    previewQuality,
    totalFrameSize: timeIndex.reduce((a, b) => a + b.size, 0),
    countFrames: timeIndex.length,
    startFrame: timeIndex[0]?.time || new Date(timeIndex[0].time * 1000),
    config,
    moreInfo
  },null,2));
  res.end();
}

function sendMJPEGHeaders(res: ServerResponse) {
  res.writeHead(200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
    Pragma: 'no-cache',
    Connection: 'close',
    'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
  });
}

function sendFrame(res: ServerResponse, frameData: Buffer) {
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

async function streamPreview(req: EventEmitter, res: Writable, fps: number = config.camera.fps) {
  let frameSent = true;
  let prevFrameSent = true;
  const previewFrame = async (frameData: Buffer) => {
    try {
      if (!frameSent && prevFrameSent) {
        previewQuality = Math.max(MINIMUM_QUALITY, (previewQuality-1) * 0.9);
        if (camera.running) {
          await camera.setConfig(cameraConfig({ quality: previewQuality, fps }));
        }
        return;
      }

      if (frameSent) {
        previewQuality += 0.125; // Takes effect after 8 frames
        if (camera.running) {
          await camera.setConfig(cameraConfig({ quality: previewQuality, fps }));
        }
      }

    } catch (e) {
      console.warn("Failed to change quality", e);
    } finally {
      prevFrameSent = frameSent;
    }

    try {
      frameSent = false;
      res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
      await write(res, frameData);
      frameSent = true
    }
    catch (ex) {
      console.warn('Unable to send frame', ex);
    }
  };

  if (camera.lastFrame)
    previewFrame(camera.lastFrame);

  camera.on('frame', previewFrame);
  if (!camera.running)
    await camera.start(cameraConfig({ quality: previewQuality, fps }));

  req.once('close', async () => {
    res.end();
    camera.removeListener('frame', previewFrame);
    if (camera.listenerCount('frame') === 0) {
      await camera.stop();
    }
  });
}

async function streamTimelapse(req: EventEmitter, res: Writable, { fps, speed, since, fast }: { fps: number; speed: number; since?: Date, fast?: true }) {
  let closed = false;
  req.once('close', () => closed = true);
  if (speed < 0) {
    throw new Error("Not yet implemented");
  } else {
    let frameIndex = binarySearch(timeIndex, (since ? since.getTime() / 1000 : 0) as TimeStamp, (t, n) => t.time - n);
    if (frameIndex < 0)
      frameIndex = ~frameIndex;
    while (!closed) {
      let time = (Date.now() / 1000);

      // Send a frame to the client
      const frame = timeIndex[frameIndex];
      res.write(`--myboundary; id=${frame.time}\nContent-Type: image/jpg\nContent-length: ${frame.size}\n\n`);
      const flushed = write(res, await readFile(timelapseDir + frame.name));
      if (!fast)
        await flushed;

      // Having written the first frame, we'll want to send another one in T+1/fps in real time.
      // which is T+speed/fps in timelapse time. 
      let nextFrameIndex = binarySearch(timeIndex, frame.time + speed / fps || 0 as TimeStamp, (t, n) => t.time - n);
      if (nextFrameIndex < 0)
        nextFrameIndex = ~nextFrameIndex;
      if (nextFrameIndex === frameIndex)
        nextFrameIndex += 1;

      // Check we've not run out of frames
      if (nextFrameIndex >= timeIndex.length) {
        const finalFrame = await readFile(timelapseDir + timeIndex[timeIndex.length - 1].name);
        res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${finalFrame.length}\n\n`);
        res.write(finalFrame);
        res.end();
        return;
      }

      if (!fast) {
        // Sleep until the actual time the next frame is due. If that's negative, skip extra frames until we can sleep
        const deviation = (Date.now() / 1000 - time);
        let d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
        while (d < deviation && !closed) {
          nextFrameIndex += 1;
          if (nextFrameIndex >= timeIndex.length) {
            const finalFrame = await readFile(timelapseDir + timeIndex[timeIndex.length - 1].name);
            res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${finalFrame.length}\n\n`);
            res.write(finalFrame);
            res.end();
            return;
          }
          d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
        }

        await sleep(d - deviation);
      }
      frameIndex = nextFrameIndex;
    }
  }
}

async function takePhoto(quality = PHOTO_QUALITY): Promise<Buffer> {
  if (!camera.running) {
    await camera.start(cameraConfig({ quality }));
    await sleep(1); // Wait for camaera to do AWB and Exposure control
    const frameData = await camera.nextFrame();
    await sleep(0.1);
    await camera.stop();
    return frameData;
  } else {
    await camera.setConfig(cameraConfig({ quality}));
    await camera.nextFrame();
    const frameData = await camera.nextFrame();
    await camera.setConfig(cameraConfig({ quality: previewQuality }));
    return frameData;
  }
}

async function saveTimelapse() {
  // init timelapse index
  try {
    const timelapseIndex = readFileSync(timelapseDir + "state.ndjson").toString();
    timeIndex = timelapseIndex.split(/\n|\n\r|\r\n/).map(r => {
      try {
        return JSON.parse(r);
      } catch (e) {
        return undefined
      }
    }).filter(o => o && typeof o.time === 'number' && typeof o.name === 'string');
  } catch (e) {
    console.warn("Timelapse index", e);
  }
  if (timeIndex.length === 0) {
    console.log("Timelapse index missing or unreadable");
    // Check the file system for images
    const newIndex = await createStateFromFileSystem(timelapseDir);
    // We do a sync write to ensure the file can't be appended to in mid-write
    writeFileSync(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"))
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
      await mkdir(timelapseDir + path, { recursive: true });
      const frameName = path + '/'
        + String(now.getHours()).padStart(2, '0') + '_'
        + String(now.getMinutes()).padStart(2, '0') + '_'
        + String(now.getSeconds()).padStart(2, '0') + '.jpg';

      await writeFile(timelapseDir + frameName, photo);
      const entry: TimeIndex = {
        name: frameName,
        size: photo.length,
        time: Math.floor(now.getTime() / 1000) as TimeStamp
      };

      await appendFile(timelapseDir + "state.ndjson", JSON.stringify(entry) + "\n");
      timeIndex.push(entry)
    } catch (e) {
      console.warn("Failed to take timelapse photo", e);
    }
    await sleep(nextTimelapse - Date.now() / 1000);
  }
}

createServer(handleHttpRequest).listen(PORT, async () => {
  console.log(`Verison ${require('../package.json').version}: listening on port ${PORT}`);
  saveTimelapse();
});
