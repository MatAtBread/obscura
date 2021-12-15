import { ServerResponse } from "http";

export function sleep(seconds: number) {
    if (seconds > 0)
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return Promise.resolve();
}

export function write(res: ServerResponse, data: string | Buffer) {
    return new Promise(resolve => res.write(data, resolve));
}
