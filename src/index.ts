import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { writeFile, readFile, mkdir, appendFile } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

import serveStatic from 'serve-static';
import camera from 'pi-camera-native-ts';
import binarySearch from 'binary-search';

import { TimeIndex, TimeStamp } from './types';
import { sleep, write } from './helpers';
import { redeploy, createStateFromFileSystem } from './admin';

// Configurable values
const FPS_TRANSITION = 30;      // Threshold of dropped/extra frames before the preview algorithm changes quality
const PHOTO_QUALITY = 90;       // Quality for downloaded photo images
const DEFAULT_QUALITY = 12;
const PORT = 8000;

const defaults = {
  width: 1920,
  height: 1080,
  fps: 20,
  encoding: 'JPEG',
  quality: DEFAULT_QUALITY
};

const timelapse = {
  quality: DEFAULT_QUALITY,  // Quality of timelapse images
  playbackFps: 15,     // Target FPS for timelapse playback
  speed: 3600,         // Default: 1 hour -> 1 second (or 1 hour=>6 seconds, 1 day=>2m24s)
  intervalSeconds: 300 // Record one frame every 5 minutes (value in seconds)  
}

// Pre-calculated constants
const timelapseDir = path.join(__dirname, '../www/timelapse/');
const wwwStatic = serveStatic(path.join(__dirname, '../www'));

// Other singleton variables
const preview = { ...defaults };
let lastFrame: Buffer | undefined;
let timeIndex: Array<TimeIndex> = [];

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL("http://server" + req.url);
    const qs = url.searchParams;

    switch (url.pathname) {
      case '/info':
      case '/info/':
        res.setHeader("Content-type", "application/json");
        res.write(JSON.stringify({
          totalFrameSize: timeIndex.reduce((a,b) => a + b.size, 0),
          countFrames: timeIndex.length,
          startFrame: timeIndex[0]?.time || new Date(timeIndex[0].time),
          preview,
          timelapse
        }));
        res.end();
        return;

      case '/admin/redeploy':
      case '/admin/redeploy/':
        redeploy(res);
        return;

      case '/admin/build-state':
      case '/admin/build-state/':
        const newIndex = await createStateFromFileSystem(timelapseDir);
        // We do a sync write to ensure teh file can't
        // be appended to in mid-write
        writeFileSync(timelapseDir + "state.ndjson", timeIndex.map(e => JSON.stringify(e)).join("\n"))
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
        await streamTimelapse(req, res, {
          fps: Number(qs.get('fps') || timelapse.playbackFps),
          since: qs.has('since') ? new Date(qs.get('since') || 0) : undefined,
          speed: Number(qs.get('speed') || timelapse.speed)
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
    }
    if (!req.url || req.url.indexOf('..') >= 0)
      throw new Error('Not found');

    if (req.url.endsWith('/'))
      req.url += "index.html";

    wwwStatic(req, res, () => {
      res.statusCode = 404;
      res.write("Not found: "+req.url);
      res.end();
    });
  } catch (ex: any) {
    res.statusCode = 500;
    if (ex)
      res.write('message' in ex ? ex.message : ex.toString());
    res.end();
  }
}

function sendFrame(res:ServerResponse, frameData: Buffer) {
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

async function streamPreview(req: IncomingMessage, res:ServerResponse) {
  res.writeHead(200, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
    Pragma: 'no-cache',
    Connection: 'close',
    'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
  });

  let frameSent = true;
  let dropped = 0;
  let passed = 0;
  const previewFrame = async (frameData: Buffer) => {
    lastFrame = frameData;
    try {
      if (!frameSent) {
        if (++dropped > FPS_TRANSITION) {
          preview.quality = Math.max(2, Math.floor(preview.quality * 0.8));
          if (camera.listenerCount('frame') > 0) {
            passed = 0;
            dropped = 0;
            console.log("frame-", frameData.length, preview.quality);
            await camera.setConfig(preview);
          }
        }
        return;
      }

      if (++passed > dropped + FPS_TRANSITION) {
        preview.quality += 1;
        if (camera.listenerCount('frame') > 0) {
          passed = 0;
          dropped = 0;
          console.log("frame+", frameData.length, preview.quality);
          await camera.setConfig(preview);
        }
      }
    } catch (e) {
      console.warn("Failed to change quality", e);
    }

    try {
      frameSent = false;
      res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
      await write(res, frameData);
      frameSent = true
    }
    catch (ex) {
      console.warn('Unable to send frame', ex);
    } finally {
      
    }
  };

  if (lastFrame)
    previewFrame(lastFrame);

  camera.on('frame', previewFrame);
  if (camera.listenerCount('frame') === 1)
    await camera.start(preview); //await camera.resume();

  req.once('close', async () => {
    res.end();
    camera.removeListener('frame', previewFrame);
    if (camera.listenerCount('frame') === 0) {
      if (preview.quality < defaults.quality)
        preview.quality = defaults.quality;
      //await camera.setConfig(options);
      //await camera.pause();
      await camera.stop();
    }
  });
}

async function streamTimelapse(req: IncomingMessage, res:ServerResponse, { fps, speed, since }: { fps: number; speed: number; since?: Date }) {
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
    } else {
      let frameIndex = binarySearch(timeIndex, (since ? since.getTime() : 0) as TimeStamp, (t, n) => t.time - n);
      if (frameIndex < 0)
        frameIndex = ~frameIndex;
      while (!closed) {
        let time = (Date.now() / 1000);
  
        // Send a frame to the client
        const frame = timeIndex[frameIndex];
        res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frame.size}\n\n`);
        await write(res, await readFile(timelapseDir + frame.name));

        // Having written the first frame, we'll want to send another one in T+1/fps in real time.
        // which is T+speed/fps in timelapse time. 
        let nextFrameIndex = binarySearch(timeIndex, frame.time + speed/fps || 0 as TimeStamp, (t, n) => t.time - n);
        if (nextFrameIndex < 0)
          nextFrameIndex = ~nextFrameIndex;        
        if (nextFrameIndex === frameIndex)
          nextFrameIndex += 1;

        // Check we've not run out of frames
        if (nextFrameIndex >= timeIndex.length) {
          const finalFrame = await readFile(timelapseDir + timeIndex[timeIndex.length-1].name);
          res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${finalFrame.length}\n\n`);
          return res.write(finalFrame);
        }

        // Sleep until the actual time the next frame is due. If that's negative, skip extra frames until we can sleep
        const deviation = (Date.now()/1000 - time);
        let d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
        while (d < deviation) {
          nextFrameIndex += 1;
          if (nextFrameIndex >= timeIndex.length) {
            const finalFrame = await readFile(timelapseDir + timeIndex[timeIndex.length-1].name);
            res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${finalFrame.length}\n\n`);
            return res.write(finalFrame);
          }
          d = (timeIndex[nextFrameIndex].time - frame.time) / speed;
        }
        
        await sleep(d - deviation);
        frameIndex = nextFrameIndex;
      }
    }
  } catch (ex) {
    console.warn("Timelapse", ex);
  } finally {
    res.end();
  }
}

async function takePhoto(quality = PHOTO_QUALITY): Promise<Buffer> {
  if (!camera.running) {
    await camera.start({ ...preview, quality: quality });
    await sleep(1); // Wait for camaera to do AWB and Exposure control
    const frameData = await camera.nextFrame();
    await sleep(0.1);
    await camera.stop();
    return frameData;
  } else {
    await camera.setConfig({ ...preview, quality: quality });
    await camera.nextFrame();
    const frameData = await camera.nextFrame();
    await camera.setConfig(preview);
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
  console.log("Timelapse index length", timeIndex.length);
  let nextTimelapse = Math.floor(Date.now() / 1000);

  while (true) {
    try {
      nextTimelapse += timelapse.intervalSeconds;
      const photo = lastFrame = await takePhoto(timelapse.quality);
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
