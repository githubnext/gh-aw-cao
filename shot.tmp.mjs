import { chromium } from "playwright-core";
const vars = ["--sl-color-bg","--sl-color-black","--sl-color-white","--sl-color-gray-1","--sl-color-gray-2","--sl-color-gray-3","--sl-color-gray-5","--sl-color-gray-6","--sl-color-green","--sl-color-text-accent","--sl-color-accent","--sl-nav-height","--sl-text-xs","--sl-text-sm","--sl-text-base","--sl-text-lg","--sl-text-3xl","--sl-font","--sl-font-mono"];
const b = await chromium.launch();
for (const theme of ["dark","light"]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.addInitScript((t) => localStorage.setItem("starlight-theme", t), theme);
  await p.goto("http://localhost:4400/gh-aw-cao/setup/", { waitUntil: "networkidle" });
  console.log(theme, await p.evaluate((vs) => {
    const s = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return { vars: Object.fromEntries(vs.map((v)=>[v, s.getPropertyValue(v).trim()])), bodyFont: body.fontFamily, bodyBg: body.backgroundColor };
  }, vars));
  await p.close();
}
await b.close();
