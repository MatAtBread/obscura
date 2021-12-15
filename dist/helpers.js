"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.write = exports.sleep = void 0;
function sleep(seconds) {
    if (seconds > 0)
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return Promise.resolve();
}
exports.sleep = sleep;
function write(res, data) {
    return new Promise(resolve => res.write(data, resolve));
}
exports.write = write;
