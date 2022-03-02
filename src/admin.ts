import { exec } from "child_process";
import { Writable } from 'stream';
import { readdir, stat } from "fs/promises";
import path from 'path'

import type { TimeIndex, TimeStamp } from './types';
import { write } from "./helpers";

export async function createStateFromFileSystem(root: string, useNamesForTime: boolean = true): Promise<TimeIndex[]> {
  const t: TimeIndex[] = [];

  // For each day
  for (const day of await readdir(root)) {
    const d = await stat(path.join(root, day));
    if (d.isDirectory()) {
      for (const file of await readdir(path.join(root, day))) {
        const s = await stat(path.join(root, day, file));
        if (s.isFile() && file.endsWith('.jpg')) {
          const time = Math.floor((useNamesForTime ? new Date(day.replace(/_/g,"-")+"T"+file.split(".")[0].replace(/_/g,":")+"Z").getTime() : s.ctime.getTime()) / 1000) as TimeStamp;
          if (time)
            t.push({
              name: path.join(day, file),
              size: s.size,
              time
            })
        }
      }
    }
  }

  t.sort((a, b) => a.time - b.time)
  return t;
}

export function redeploy(res: Writable) {
  console.log("Re-deploying");
  const p = exec('npm run deploy', async (error, stdout, stderr) => {
    await write(res, stdout + '\n\n');
    if (error) {
      await write(res, "ERROR:" + error.message + '\n\n' + stderr);
      res.end();
    } else {
      await write(res, "Restarting....");
      res.end();
      exec('pm2 restart obscura');
    }
  });
  p.stdout?.pipe(process.stdout);
  p.stderr?.pipe(process.stderr);
}
