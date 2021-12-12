import { createServer } from 'http';
import { URL } from 'url';
import { writeFile, stat, readFile } from 'fs/promises';
import serveStatic from 'serve-static';
import path from 'path';
import camera from 'pi-camera-native-ts';

// Configurable values
const FPS_TRANSITION = 20;
const PHOTO_QUALITY = 90;
const TIMELAPSE_QUALITY = 20;
const TIMELAPSE_FPS = 10;
const TIMELAPSE_INTERVAL = 60000; // One frame per minute
const PORT = 8000;
const defaults = {
  width: 1920,
  height: 1080,
  fps: 20,
  encoding: 'JPEG',
  quality: 7
};

// Pre-calculated constants
const timelapseDir = path.join(__dirname, '../www/timelapse/');
const serve = serveStatic(path.join(__dirname, '../www'));

let lastFrame: Buffer;
const options = { ...defaults };

function sleep(seconds: number) {
  return new Promise(resolve => setTimeout(resolve,seconds * 1000));
}

createServer(async (req, res) => {
  try {
    const url = new URL("http://server"+req.url);
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
        return ;

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
    })
  } catch (ex:any) {
    res.statusCode = 500;
    if (ex) res.write('message' in ex ? ex.message : ex.toString());
    res.end();
  }

  function sendFrame(frameData: Buffer) {
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
    const frameHandler = async (frameData: Buffer) => {
      lastFrame = frameData;
      try {
        if (!frameSent) {
          if (++dropped > FPS_TRANSITION) {
            options.quality = Math.floor(options.quality * 0.876);
            if (camera.listenerCount('frame') > 0) {
              passed = 0;
              dropped = 0;
              console.log(req.url, "frame-", frameData.length, options.quality);
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
            console.log("\n"+req.url, "frame+", frameData.length, options.quality);
            await camera.setConfig(options);
          }
        }
      } catch (e) {
        console.warn("\nFailed to change quality",e);
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

    camera.on('frame', frameHandler);
    if (camera.listenerCount('frame') === 1)
      await camera.start(options); //await camera.resume();

    req.on('close', async () => {
      camera.removeListener('frame', frameHandler);
      sleep(1).then(()=>{
        if (camera.listenerCount('frame') === 0) {
          options.quality = defaults.quality;
          //await camera.setConfig(options);
          //await camera.pause();
          return camera.stop();
        }
      })
    });
  }

  async function streamTimelapse({fps, speed, reverse, since}:{fps: number, speed: number, since: number, reverse: boolean}) {
    res.writeHead(200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0',
      Pragma: 'no-cache',
      Connection: 'close',
      'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary'
    });

    let nextFrameTime = Date.now();
    let photo;
    for (photo = reverse ? photoCount-1 : 1; photo > 0; photo += speed * (reverse?-1:1)) {
      nextFrameTime += (1000/fps);
      const frameName = timelapseDir+photo+".jpg";
      const info = await stat(frameName);
      res.write(`--myboundary\nContent-Type: image/jpg\nContent-length: ${info.size}\n\n`);
      res.write(await readFile(frameName));
      const now = Date.now();
      if (now < nextFrameTime)
        await sleep((nextFrameTime - now)/1000);
    }

    req.on('close', async () => photo = -1);
  }
}).listen(PORT, async () => { 
  //await camera.start(defaults);
  //await camera.pause();
  console.log('Listening on port '+PORT);
});

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

let photoCount: number;
try {
  const saved = require(timelapseDir+"state.json") as { photoCount: number };
  photoCount = saved.photoCount;
  console.log("Timelapse series continue from ", photoCount);
} catch (e) {
  console.log("No saved state, starting a new timelapse series");
  photoCount = 1;
}
setInterval(async ()=>{
  try {
    const photo = await takePhoto(TIMELAPSE_QUALITY) ;
    const frameName = timelapseDir+photoCount+".jpg";
    await writeFile(frameName, photo);
    photoCount += 1;
    await writeFile(timelapseDir+"state.json", JSON.stringify({ photoCount }));
  } catch (e) {
    console.warn("Failed to take timelapse photo",e);
  }
}, TIMELAPSE_INTERVAL);
