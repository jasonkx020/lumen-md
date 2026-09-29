/**
 * picture 主题解析自检（DOM 环境）。
 */
import { applyPictureTheme, firstSrcsetUrl } from "./pictureTheme";

const STAR = `<a href="https://star-history.com/#78/xiaozhi-esp32&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=78/xiaozhi-esp32&type=Date" />
 </picture>
</a>`;

export function runPictureThemeSelfCheck(): string[] {
  const errors: string[] = [];
  if (firstSrcsetUrl("https://a.example/x.svg 1x") !== "https://a.example/x.svg") {
    errors.push("firstSrcsetUrl failed");
  }

  const darkRoot = document.createElement("div");
  darkRoot.innerHTML = STAR;
  applyPictureTheme(darkRoot, true);
  const darkImg = darkRoot.querySelector("img");
  if (!darkImg?.getAttribute("src")?.includes("theme=dark")) {
    errors.push("dark theme did not select dark srcset");
  }

  const lightRoot = document.createElement("div");
  lightRoot.innerHTML = STAR;
  applyPictureTheme(lightRoot, false);
  const lightImg = lightRoot.querySelector("img");
  const lightSrc = lightImg?.getAttribute("src") ?? "";
  if (!lightSrc.includes("type=Date") || lightSrc.includes("theme=dark")) {
    errors.push("light theme did not select light srcset");
  }

  return errors;
}
