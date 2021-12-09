import { stdout } from 'process';
import { camera } from './raspivid';
import JMuxer from 'jmuxer';
import { Duplex } from 'stream';
import { createServer } from 'http';
import serveStatic from 'serve-static';
import path from 'path';

class JVideoMuxer extends JMuxer {
    stream: Duplex | undefined;

    createVideoStream() {
        let feed = this.feed.bind(this);
        let destroy = this.destroy.bind(this);
        this.stream = new Duplex({
            writableObjectMode: true,
            read(size) {
            },
            write(data, encoding, callback) {
                try {
                    feed({video:data});
                } catch (ex:any) {
                    console.warn('feed','message' in ex ? ex.message : ex.toString());
                } finally {
                    callback();
                }
            },
            final(callback) {
                //destroy();
                callback();
            }
        });
        this.stream.on('error',(err) => {
            console.warn('stream',err?.toString());
        });
        return this.stream;
    }


}

const jmux = new JVideoMuxer({
    node: undefined as unknown as string,
    debug: true
});

/*camera({
    width: 1920,
    height: 1080,
    timeout: 0
}).pipe(jmux.createVideoStream()).pipe(stdout);*/

const serve = serveStatic(path.join(__dirname, '../www'));

/*const live = camera({
    width: 640,
    height: 480,
    timeout: 30
})*/

createServer((req,res)=>{
    console.log("req",req.url);
    switch (req.url) {
    case '/live.mp4':
        res.statusCode = 200;
        res.setHeader("Content-type", "video/mp4");
        camera({
            width: 640,
            height: 480,
            timeout: 300
        }).pipe(jmux.createVideoStream()).pipe(res);
        break;
    default:
        serve(req,res,()=>{
            res.statusCode = 404;
            res.write("Not found");
            res.end();
        })
        break;

    }
}).listen(8000, ()=>{ console.log('Listening')});