import { exec } from "child_process";
import { ServerResponse } from "http";
import { readdir, stat } from "fs/promises";
import path from 'path'

import type { TimeIndex, TimeStamp } from './types';
import { write } from "./helpers";

export async function createStateFromFileSystem(root: string): Promise<TimeIndex[]> {
    const t:TimeIndex[] = [];

    // For each day
    debugger;
    for (const day of await readdir(root)) {
        for (const file of await readdir(path.join(root, day))) {
          const s = await stat(path.join(root,day,file));
          t.push({
            name: path.join(day,file),
            size: s.size,
            time: Math.floor(s.ctime.getTime() / 1000) as TimeStamp
          })
        }
    }

    t.sort((a,b) => a.time - b.time)
    return t;
}

export function redeploy(res: ServerResponse) {
    console.log("Re-deploying");
    const p = exec('npm run deploy', async (error, stdout, stderr) => {
      await write(res, stdout + '\n\n');
      if (error) {
        await write(res, error.message + '\n\n' + stderr);
        res.end();
      } else {
        res.end();
        exec('pm2 restart obscura');
      }
    });
    p.stdout?.pipe(process.stdout);
    p.stderr?.pipe(process.stderr);
  }
  
  