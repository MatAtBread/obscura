import { exec } from "child_process";
import { ServerResponse } from "http";
import { readDir, stat } from "fs/promises";

import type { TimeIndex } from './types';
import { write } from "./helpers";

async function createStateFromFileSystem(root: string): Promise<TimeIndex[]> {
    const t:TimeIndex[] ;

    // For each day
    debugger;
    for (const day of await readDir(root)) {
        for (const file of await readDir(root + '/' + day)) {
          const s = await stat()
        }
    }
}

function redeploy(res: ServerResponse) {
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
  
  