"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.camera = void 0;
const child = __importStar(require("child_process"));
function camera(options) {
    options = options || {};
    var args = [
        '--nopreview'
    ];
    Object.keys(options).forEach(function (key) {
        args.push('--' + key);
        var val = options[key];
        if (val || val === 0) {
            args.push(String(val));
        }
    });
    args.push('-o');
    args.push('-');
    // the avconv stream that inherits stderr
    var video_process = child.spawn('raspivid', args, {
        stdio: ['ignore', 'pipe', 'inherit']
    });
    return video_process.stdout;
}
exports.camera = camera;
