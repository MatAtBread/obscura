import { createServer } from 'http';
import serveStatic from 'serve-static';
import path from 'path';
import camera from 'raspberry-pi-camera-native';

const FPS_TRANSITION = 23;

const serve = serveStatic(path.join(__dirname, '../www'));

let lastFrame: Buffer;

const defaults = {
  width: 1920 / 2,
  height: 1080 / 2,
  fps: 25,
  encoding: 'JPEG',
  quality: 7//32
};
const options = { ...defaults };

createServer(async (req, res) => {
  try {
    switch (req.url) {
      case '/photo':
        await camera.setConfig({ ...options, quality: 90});
        camera.once('frame', async (frameData)=>{
          console.log(req.url,"frame",frameData.length)          
          await camera.setConfig(options);
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
        console.log(req.url,"frame",lastFrame.length);
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
        const frameHandler = async (frameData: Buffer) => {
          lastFrame = frameData;
          if (!frameSent) {
            if (++dropped > FPS_TRANSITION) {
              options.quality = Math.floor(options.quality * 0.9);
              if (camera.listenerCount('frame') > 0) {
                passed = 0;
                dropped = 0;
                console.log(req.url,"frame-",frameData.length)
                await camera.setConfig(options);
              }
            }
            return;
          }

          if (++passed > dropped+FPS_TRANSITION) {
            options.quality += 1;
            if (camera.listenerCount('frame') > 0) {
              passed = 0;
              dropped = 0;
              console.log(req.url,"frame+",frameData.length)
              await camera.setConfig(options);
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
        }

        if (lastFrame)
          frameHandler(lastFrame);

        camera.on('frame', frameHandler);
        if (camera.listenerCount('frame') === 1)
          await camera.resume();

        req.on('close', async () => {
          camera.removeListener('frame', frameHandler);
          if (camera.listenerCount('frame') === 0) {
            await camera.pause();
            options.quality = defaults.quality;
            camera.setConfig(options);
          }
        });
        return;
    }
    serve(req, res, () => {
      res.statusCode = 404;
      res.write("Not found");
      res.end();
    })
  } catch (ex) {
    res.statusCode = 500;
    res.end();
  }
}).listen(8000, () => { 
  camera.start(defaults);
  camera.pause();
  console.log('Listening');
});