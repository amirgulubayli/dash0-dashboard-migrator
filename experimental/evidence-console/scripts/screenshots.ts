// Takes screenshots of the running server (default http://127.0.0.1:4173) at two sizes. Uses an already-installed Playwright browser.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const out = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [w, h] of [[1920, 1080], [1280, 720]] as const) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(base);
  await page.waitForSelector(".tile");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}main-${w}x${h}.png` });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log(`${w}x${h} horizontal overflow: ${overflowX}`);
  await page.getByRole("button", { name: "What needs my attention?" }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}brief-${w}x${h}.png` });
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Expand" }).click();
  await page.screenshot({ path: `${out}expanded-${w}x${h}.png` });
  await page.close();
}
await browser.close();
