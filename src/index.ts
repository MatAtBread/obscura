import { EventEmitter, Writable } from 'stream';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { writeFile, mkdir, appendFile, unlink } from 'fs/promises';
import { createReadStream, readFileSync, ReadStream, writeFileSync } from 'fs';
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

let config: {
  version: 1,
  landscape: boolean,
  camera: CameraOptions,
  timelapse: {
    quality: number,
    speed: number,
    intervalSeconds: number
  }
};

const compressing = new Map<ChildProcessWithoutNullStreams, { url: string; lastLine: string }>();
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
    camera: {
      width: 2592,
      height: 1944,
      fps: 15,
      encoding: 'JPEG',
      quality: DEFAULT_QUALITY,
      rotation: 0,
      mirror: Mirror.NONE
    },
    timelapse: {
      quality: DEFAULT_QUALITY,   // Quality of timelapse images
      speed: 14400,               // Default: 4 hours -> 1 second
      intervalSeconds: 600        // Record one frame every 5 minutes (value in seconds)  
    }
  }
}

// Configurable constants
function cameraConfig(overrides: Partial<CameraOptions> = {}) {
  const r = { ...config.camera, ...overrides };
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
let previewFrameSize = 0;
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
        const until = Math.floor((qs.has('until') ? new Date(qs.get('interval') || Date.now()).getTime() : Date.now()) / 1000);
        if (!interval || interval < config.timelapse.intervalSeconds)
          throw new Error("Invalid interval parameter");

        let removed = [] as string[];
        let lastTime = 0;
        const tNew: TimeIndex[] = [];
        for (const t of timeIndex) {
          if (t.time < until && t.time - lastTime < interval) {
            removed.push(timelapseDir + t.name);
          } else {
            tNew.push(t);
            lastTime = t.time;
          }
        }
        timeIndex = tNew;
        // We do a sync write to ensure the file can't be appended to in mid-write
        writeFileSync(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"));
        sendInfo(res, { preserved: tNew.length, removed: removed.length });
        await Promise.all(removed.map(p => unlink(p)));
        return;

      case '/photo':
      case '/photo/':
        sendFrame(res, await takePhoto(Number(qs.get('q') || PHOTO_QUALITY)));
        return;

      case '/timelapse':
      case '/timelapse/':
        const opts = {
          fps: Number(qs.get('fps') || config.camera.fps),
          start: new Date(Number(qs.get('start') || 0)),
          end: new Date(Number(qs.get('end') || Date.now())),
          speed: Number(qs.get('speed') || config.timelapse.speed)
        };

        if (qs.has("compress")) {
          // Warning: On a Pi Zero 2W, the maximum frame rate is around 5fps, even with H/W GPU support, so
          // although it does reduce the required bandwidth (in the command below, to 2Mb/s), the frame rate
          // is so reduced that MJPEG takes up approx 7-8Mb/s, which is well within the WiFi bandwidth of the
          // Pi Zero 2.

          // In any case (for example over a mobile phone, ssh, etc), both streamTimelapse & streamPreview will
          // drop frames to reduce buffering/latency, and in the case of streamPreview will also lower JPEG quality

          // This mechanism is also unsuitable for /preview/ as the latency is very high 
          const bitrate = qs.get('compress') || "2M";
          const { width, height } = cameraConfig();
          const scale = Math.max(width / 1920, height / 1080);
          const args = `-f mjpeg -r ${opts.fps} -i - -f matroska -vf scale=${width / scale}:${height / scale} -vcodec h264_omx -b:v ${bitrate} -zerocopy 1 -r ${opts.fps} -`;
          //console.log(new Date(),'ffmpeg ' + args);
          let ffmpeg: ChildProcessWithoutNullStreams | undefined = spawn('ffmpeg', args.split(' '));
          compressing.set(ffmpeg, { url: req.url || '', lastLine: '' });
          ffmpeg.once('close', () => { compressing.delete(ffmpeg!); ffmpeg = undefined });
          ffmpeg.stderr.on('data', d => compressing.get(ffmpeg!)!.lastLine = d.toString());

          const killFfmpeg = (reason: string) => (e?: unknown) => {
            try {
              if (e) console.log(new Date(),'killFfmeg: ', reason, e);
              ffmpeg?.kill('SIGTERM');
            } catch (ex) { };
          };

          // If the client dies, about ffmpeg, which will unwind sendTimelapse()
          res.once('error', killFfmpeg("res error"));
          //res.once('close', killFfmpeg("res close"));
          // Pipe the output of ffmpeg to the client
          ffmpeg.stdout.pipe(res).on('error', killFfmpeg("pipe error"));

          try {
            res.writeHead(200, {
              Connection: 'close',
              'Content-Type': 'video/x-matroska'
            });
            // Send the mjpeg stream to ffmpeg, aborting if the client request is aborted
            await sendTimelapse(ffmpeg, ffmpeg.stdin, { ...opts });
          } catch (ex) {
            console.warn(new Date(),req.url, ex);
            throw ex;
          } finally {
            ffmpeg.stdin.end();
            //killFfmpeg("Complete")();
          }
        } else {
          try {
            sendMJPEGHeaders(res);
            await streamTimelapse(req, res, opts);
          } finally {
            res.end();
          }
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
    console.warn(new Date(), "Request", req.url, ex);
    res.statusCode = 500;
    if (ex)
      res.write('message' in ex ? ex.message : ex.toString());
    res.end();
  }
}

function sendInfo<MoreInfo extends {}>(res: ServerResponse, moreInfo?: MoreInfo) {
  res.setHeader("Content-type", "application/json");
  const numFrames = Math.min(timeIndex.length, 240);
  const avgFrameSize = numFrames > 20 ? timeIndex.slice(-numFrames).reduce((a, t) => a + t.size, 0) / numFrames : 0;
  res.write(JSON.stringify({
    previewQuality,
    previewFrameSize,
    '24hrAvgFrameSize': avgFrameSize,
    totalFrameSize: timeIndex.reduce((a, b) => a + b.size, 0),
    countFrames: timeIndex.length,
    startFrame: timeIndex[0]?.time || new Date(timeIndex[0].time * 1000),
    config,
    moreInfo,
    compressing: [...compressing.values()].map(v => `${v.url}\t${v.lastLine}`)
  }, null, 2));
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

async function streamPreview(req: EventEmitter, res: Writable, fps: number) {
  let frameSent = true;
  let prevFrameSent = true;
  const previewFrame = async (frameData: Buffer) => {
    try {
      if (!frameSent && prevFrameSent) {
        previewQuality = Math.max(MINIMUM_QUALITY, (previewQuality - 1) * 0.9);
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
      console.warn(new Date(), "Failed to change quality", e);
    } finally {
      prevFrameSent = frameSent;
    }

    try {
      frameSent = false;
      previewFrameSize = (previewFrameSize + frameData.length) >> 1;
      res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
      await write(res, frameData);
      frameSent = true
    }
    catch (ex) {
      console.warn(new Date(), 'Unable to send frame', ex);
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

/* Send a timelapse, ignoring real-time, but generating frames as near as possible to the target time. This includes
  duplicating or skipping frames if necessary to maintain the requested frame-rate */
async function sendTimelapse(req: EventEmitter, mjpegStream: Writable, { fps, speed, start, end }: { fps: number; speed: number; start: Date, end: Date }) {
  let closed = false;
  function close() {
    closed = true;
  }
  req.once('close', close);
  req.once('error', close);
  if (speed < 0) {
    throw new Error("Not yet implemented");
  } else {
    const numFrames = Math.min(timeIndex.length, 240);
    const avgFrameSize = numFrames > 20 ? timeIndex.slice(-numFrames).reduce((a, t) => a + t.size, 0) / numFrames : 0;

    for (let tFrame = start.getTime() / 1000; !closed && tFrame <= end.getTime() / 1000; tFrame += speed / fps) {
      let frameIndex = binarySearch(timeIndex, tFrame as TimeStamp, (t, n) => t.time - n);
      if (frameIndex < 0)
        frameIndex = ~frameIndex;
      if (frameIndex >= timeIndex.length)
        frameIndex = timeIndex.length - 1;

      const frame = timeIndex[frameIndex];
      if (frame.size > avgFrameSize / 2) {
        await streamFrame(frame, mjpegStream);
      }
    }
  }
}

async function streamFrame(frame: TimeIndex, dest: Writable) {
  await write(dest, `--myboundary; id=${frame.time}\nContent-Type: image/jpg\nContent-length: ${frame.size}\n\n`);
  let file: ReadStream | undefined = undefined;
  try {
    file = createReadStream(timelapseDir + frame.name);
    for await (const chunk of file) {
      await write(dest, chunk);
    }
  } finally {
    file?.close();
  }
}

/* Stream images in real-time, which means taking account of the actual elapsed time to send an image
  so the stream, as near as possible, tracks elapsed time. This never duplicates frames - we just wait
  longer that the target frame rate if necessary to ensure the stream remains in sync */
async function streamTimelapse(req: EventEmitter, res: Writable, { fps, speed, start, end }: { fps: number; speed: number; start: Date, end: Date }) {
  let closed = false;
  req.once('close', () => closed = true);
  req.once('error', () => closed = true);
  if (speed < 0) {
    throw new Error("Not yet implemented");
  } else {
    const numFrames = Math.min(timeIndex.length, 240);
    const avgFrameSize = numFrames > 20 ? timeIndex.slice(-numFrames).reduce((a, t) => a + t.size, 0) / numFrames : 0;
    let frameIndex = binarySearch(timeIndex, (start.getTime() / 1000) as TimeStamp, (t, n) => t.time - n);
    if (frameIndex < 0)
      frameIndex = ~frameIndex;
    let finalIndex = binarySearch(timeIndex, (end.getTime() / 1000) as TimeStamp, (t, n) => t.time - n);
    if (finalIndex < 0)
      finalIndex = ~finalIndex;

    while (!closed) {
      async function sendFinalFrame() {
        if (nextFrameIndex >= timeIndex.length) {
          await streamFrame(timeIndex[timeIndex.length - 1], res);
        }
        res.end();
      }

      let time = (Date.now() / 1000);

      // Send a frame to the client
      let frame = timeIndex[frameIndex];
      await streamFrame(frame, res);

      // Having written the first frame, we'll want to send another one in T+1/fps in real time.
      // which is T+speed/fps in timelapse time. 
      let nextFrameIndex = binarySearch(timeIndex, frame.time + speed / fps || 0 as TimeStamp, (t, n) => t.time - n);
      if (nextFrameIndex < 0)
        nextFrameIndex = ~nextFrameIndex;
      if (nextFrameIndex === frameIndex)
        nextFrameIndex += 1;

      // Check we've if run out of frames, and skip over "blank" frames (like night time)
      while (true) {
        if (nextFrameIndex >= timeIndex.length || nextFrameIndex > finalIndex)
          return sendFinalFrame();
        if (timeIndex[nextFrameIndex].size > avgFrameSize / 2)
          break;
        frame = timeIndex[nextFrameIndex];
        nextFrameIndex += 1;
      }

      // Sleep until the actual time the next frame is due. If that's negative, skip extra frames until we can sleep
      const deviation = (Date.now() / 1000 - time);
      let d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
      while (d < deviation && !closed) {
        nextFrameIndex += 1;
        if (nextFrameIndex >= timeIndex.length || nextFrameIndex > finalIndex)
          return sendFinalFrame();
        d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
      }
      await sleep(d - deviation);
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
    await camera.setConfig(cameraConfig({ quality }));
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
    console.warn(new Date(), "Timelapse index", e);
  }
  if (timeIndex.length === 0) {
    console.log(new Date(), "Timelapse index missing or unreadable");
    // Check the file system for images
    const newIndex = await createStateFromFileSystem(timelapseDir);
    // We do a sync write to ensure the file can't be appended to in mid-write
    writeFileSync(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"))
    timeIndex = newIndex;
  }
  console.log(new Date(), "Timelapse index length", timeIndex.length);
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
      console.warn(new Date(), "Failed to take timelapse photo", e);
    }
    await sleep(nextTimelapse - Date.now() / 1000);
  }
}

createServer(handleHttpRequest).listen(PORT, async () => {
  console.log(new Date(), `Verison ${require('../package.json').version}: listening on port ${PORT}`);
  saveTimelapse();
});
