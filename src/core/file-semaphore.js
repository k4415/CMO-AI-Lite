import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireFileSemaphore(basePath, concurrency = 1, options = {}) {
  const slots = Math.max(1, Number(concurrency) || 1);
  const staleMs = Math.max(60000, Number(options.staleMs) || 3 * 60 * 1000);
  await fs.mkdir(basePath, { recursive: true });
  while (true) {
    for (let index = 0; index < slots; index += 1) {
      const slotPath = path.join(basePath, `slot-${index}`);
      try {
        await fs.mkdir(slotPath);
        const heartbeat = setInterval(() => {
          const now = new Date();
          fs.utimes(slotPath, now, now).catch(() => null);
        }, Math.max(30000, Math.floor(staleMs / 3)));
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          await fs.rm(slotPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(slotPath);
          if (Date.now() - stat.mtimeMs > staleMs) await fs.rm(slotPath, { recursive: true, force: true });
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
      }
    }
    await sleep(100 + Math.floor(Math.random() * 100));
  }
}
