"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redeploy = exports.createStateFromFileSystem = void 0;
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
const helpers_1 = require("./helpers");
async function createStateFromFileSystem(root) {
    const t = [];
    // For each day
    for (const day of await (0, promises_1.readdir)(root)) {
        const d = await (0, promises_1.stat)(path_1.default.join(root, day));
        if (d.isDirectory()) {
            for (const file of await (0, promises_1.readdir)(path_1.default.join(root, day))) {
                const s = await (0, promises_1.stat)(path_1.default.join(root, day, file));
                if (s.isFile() && file.endsWith('.jpg')) {
                    t.push({
                        name: path_1.default.join(day, file),
                        size: s.size,
                        time: Math.floor(s.ctime.getTime() / 1000)
                    });
                }
            }
        }
    }
    t.sort((a, b) => a.time - b.time);
    return t;
}
exports.createStateFromFileSystem = createStateFromFileSystem;
function redeploy(res) {
    console.log("Re-deploying");
    const p = (0, child_process_1.exec)('npm run deploy', async (error, stdout, stderr) => {
        await (0, helpers_1.write)(res, stdout + '\n\n');
        if (error) {
            await (0, helpers_1.write)(res, error.message + '\n\n' + stderr);
            res.end();
        }
        else {
            res.end();
            (0, child_process_1.exec)('pm2 restart obscura');
        }
    });
    p.stdout?.pipe(process.stdout);
    p.stderr?.pipe(process.stderr);
}
exports.redeploy = redeploy;
