"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const raspivid_1 = require("./raspivid");
const jmuxer_1 = __importDefault(require("jmuxer"));
const stream_1 = require("stream");
const http_1 = require("http");
const serve_static_1 = __importDefault(require("serve-static"));
const path_1 = __importDefault(require("path"));
class JVideoMuxer extends jmuxer_1.default {
    createVideoStream() {
        let feed = this.feed.bind(this);
        let destroy = this.destroy.bind(this);
        this.stream = new stream_1.Duplex({
            writableObjectMode: true,
            read(size) {
            },
            write(data, encoding, callback) {
                try {
                    feed({ video: data });
                }
                catch (ex) {
                    console.warn('feed', 'message' in ex ? ex.message : ex.toString());
                }
                finally {
                    callback();
                }
            },
            final(callback) {
                //destroy();
                callback();
            }
        });
        this.stream.on('error', (err) => {
            console.warn('stream', err?.toString());
        });
        return this.stream;
    }
}
const jmux = new JVideoMuxer({
    node: undefined,
    debug: true
});
/*camera({
    width: 1920,
    height: 1080,
    timeout: 0
}).pipe(jmux.createVideoStream()).pipe(stdout);*/
const serve = (0, serve_static_1.default)(path_1.default.join(__dirname, '../www'));
/*const live = camera({
    width: 640,
    height: 480,
    timeout: 30
})*/
(0, http_1.createServer)((req, res) => {
    console.log("req", req.url);
    switch (req.url) {
        case '/live.mp4':
            res.statusCode = 200;
            res.setHeader("Content-type", "video/mp4");
            (0, raspivid_1.camera)({
                width: 640,
                height: 480,
                timeout: 300
            }).pipe(jmux.createVideoStream()).pipe(res);
            break;
        default:
            serve(req, res, () => {
                res.statusCode = 404;
                res.write("Not found");
                res.end();
            });
            break;
    }
}).listen(8000, () => { console.log('Listening'); });
