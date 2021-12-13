import { createServer, IncomingMessage, RequestListener, ServerResponse } from 'http';
import { URL } from 'url';
import { writeFile, stat, readFile, mkdir, appendFile } from 'fs/promises';
import { readFileSync } from 'fs';
import serveStatic from 'serve-static';
import path from 'path';
import camera from 'pi-camera-native-ts';
import binarySearch from 'binary-search';

// Configurable values
const FPS_TRANSITION = 20;
const PHOTO_QUALITY = 90;
const TIMELAPSE_QUALITY = 20;
const TIMELAPSE_FPS = 10;
const TIMELAPSE_INTERVAL = 60; // One frame per minute (in seconds)
const PORT = 8000;
const defaults = {
  width: 1920,
  height: 1080,
  fps: 20,
  encoding: 'JPEG',
  quality: 7
};

// Debug things
const TRACE_REQUESTS = true;

// Pre-calculated constants
const timelapseDir = path.join(__dirname, '../www/timelapse/');
const wwwStatic = serveStatic(path.join(__dirname, '../www'));

// Current state for timelapse
type TimeStamp = number & { TimeStamp: 'TimeStamp' };
interface TimeIndex {
  time: TimeStamp,
  name: string
}
let lastFrame: Buffer | undefined;
let timeIndex: Array<TimeIndex> = [];
let nextTimelapse = Math.floor(Date.now() / 1000);
const options = { ...defaults };

function sleep(seconds: number) {
  if (seconds > 0)
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  return Promise.resolve();
}

let reqID = 1;
const handleHttpRequest: RequestListener = async (req: IncomingMessage, res: ServerResponse & { id?: number }) => {
  const log = TRACE_REQUESTS ? (msg: string, ...args: any[]) => {
    console.log(`${msg}\t${req.url} <${res.id}>`, ...args);
  } : console.log.bind(console);

  try {
    const url = new URL("http://server" + req.url);
    const qs = url.searchParams;

    if (TRACE_REQUESTS) {
      res.id = reqID++;
      log("request");
      const _end = res.end.bind(res);
      res.end = () => { log("end"); _end() };
      res.once('close', () => log("close"));
    }

    switch (url.pathname) {
      case '/photo':
      case '/photo/':
        sendFrame(await takePhoto());
        return;

      case '/timelapse':
      case '/timelapse/':
        await streamTimelapse({
          fps: Number(qs.get('fps') || TIMELAPSE_FPS),
          since: Number(qs.get('since')) as TimeStamp || undefined,
          speed: Number(qs.get('speed') || 60)
        });
        return;

      case '/lastframe':
      case '/lastframe/':
        if (!lastFrame)
          throw new Error("Camera not started");
        sendFrame(lastFrame);
        return;

      case '/preview':
      case '/preview/':
        await streamPreview();
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
  } catch (ex: any) {
    res.statusCode = 500;
    if (ex)
      res.write('message' in ex ? ex.message : ex.toString());
    res.end();
  }

  function sendFrame(frameData: Buffer) {
    log("frame", frameData.length, options.quality);
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
    const previewFrame = async (frameData: Buffer) => {
      lastFrame = frameData;
      try {
        if (!frameSent) {
          if (++dropped > FPS_TRANSITION) {
            options.quality = Math.max(1, Math.floor(options.quality * 0.8));
            if (camera.listenerCount('frame') > 0) {
              passed = 0;
              dropped = 0;
              log("frame-", frameData.length, options.quality);
              await camera.setConfig(options);
            }
          }
          return;
        }

        if (++passed > dropped + FPS_TRANSITION) {
          options.quality += 1;
          if (camera.listenerCount('frame') > 0) {
            passed = 0;
            dropped = 0;
            log("frame+", frameData.length, options.quality);
            await camera.setConfig(options);
          }
        }
      } catch (e) {
        console.warn("Failed to change quality", e);
      }

      try {
        frameSent = false;
        res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${frameData.length}\n\n`);
        res.write(frameData, () => frameSent = true);
      }
      catch (ex) {
        console.warn('Unable to send frame', ex);
      }
    };

    if (lastFrame)
      previewFrame(lastFrame);

    camera.on('frame', previewFrame);
    if (camera.listenerCount('frame') === 1)
      await camera.start(options); //await camera.resume();

    req.once('close', async () => {
      res.end();
      camera.removeListener('frame', previewFrame);
      if (camera.listenerCount('frame') === 0) {
        options.quality = defaults.quality;
        //await camera.setConfig(options);
        //await camera.pause();
        await camera.stop();
      }
    });
  }

  async function streamTimelapse({ fps, speed, since }: { fps: number; speed: number; since?: TimeStamp }) {
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
        let startIndex = Math.abs(binarySearch(timeIndex, since || 0 as TimeStamp, (t, n) => t.time - n));
        while (!closed) {
          const now = Date.now();
          since = timeIndex[startIndex].time;
          const frameName = timeIndex[startIndex].name;
          const info = await stat(frameName);
          res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${info.size}\n\n`);
          res.write(await readFile(frameName));

          let delay = 0;
          while (delay < 1 / TIMELAPSE_FPS) {
            startIndex += 1;
            if (!timeIndex[startIndex])
              break; // No more images
            delay = (timeIndex[startIndex].time - since)/speed;
          }
          await sleep(delay - (Date.now() - now)/1000);
        }
      }
    } catch (ex) {
      console.warn("Timelapse", ex);
    } finally {
      res.end();
    }
  }
}

async function takePhoto(quality = PHOTO_QUALITY): Promise<Buffer> {
  if (!camera.running) {
    await camera.start({ ...options, quality: quality });
    await sleep(1); // Wait for camaera to do AWB and Exposure control
    const frameData = await camera.nextFrame();
    await sleep(0.1);
    await camera.stop();
    return frameData;
  } else {
    await camera.setConfig({ ...options, quality: quality });
    await camera.nextFrame();
    const frameData = await camera.nextFrame();
    await camera.setConfig(options);
    return frameData;
  }
}


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

async function saveTimelapse() {
  while (true) {
    try {
      nextTimelapse += TIMELAPSE_INTERVAL;
      const photo = await takePhoto(TIMELAPSE_QUALITY);
      const now = new Date();
      const path = timelapseDir
        + String(now.getUTCFullYear()) + '_'
        + String(now.getMonth() + 1).padStart(2, '0') + '_'
        + String(now.getUTCDate()).padStart(2, '0');
      await mkdir(path, { recursive: true });
      const frameName = path + '/'
        + String(now.getHours()).padStart(2, '0') + '_'
        + String(now.getMinutes()).padStart(2, '0') + '_'
        + String(now.getSeconds()).padStart(2, '0') + '.jpg';

      await writeFile(frameName, photo);
      console.log("Write ", frameName);
      const entry: TimeIndex = { time: Math.floor(now.getTime() / 1000) as TimeStamp, name: frameName };
      await appendFile(timelapseDir + "state.ndjson", JSON.stringify(entry) + "\n");
      timeIndex.push(entry)
    } catch (e) {
      console.warn("Failed to take timelapse photo", e);
    }
    await sleep(nextTimelapse - Date.now() / 1000);
  }
}

createServer(handleHttpRequest).listen(PORT, async () => {
  //await camera.start(defaults);
  //await camera.pause();
  console.log('Listening on port ' + PORT);
  saveTimelapse();
});
