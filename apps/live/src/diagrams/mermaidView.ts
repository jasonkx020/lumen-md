/** 在 Crepe 宿主内把 language=mermaid 的代码块渲染为 SVG（不替换 NodeView）。 */

import mermaid from "mermaid";

let ready = false;

function ensure() {
  if (ready) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
  });
  ready = true;
}

async function renderBlock(pre: HTMLElement) {
  if (pre.dataset.mermaidDone === "1") return;
  const code =
    pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
  const host = pre.parentElement;
  if (!host) return;

  let chart = host.querySelector<HTMLElement>(":scope > .mermaid-chart");
  if (!chart) {
    chart = document.createElement("div");
    chart.className = "mermaid-chart";
    host.insertBefore(chart, pre);
  }
  ensure();
  const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const { svg } = await mermaid.render(id, code.trim() || "graph TD;A[ ]");
    chart.innerHTML = svg;
    pre.dataset.mermaidDone = "1";
    pre.classList.add("mermaid-source-collapsed");
  } catch (e) {
    chart.innerHTML = `<pre class="mermaid-error">${String(e)}</pre>`;
  }
}

function isMermaidBlock(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "PRE") {
    const lang =
      el.getAttribute("data-language") ||
      el.querySelector("code")?.className ||
      "";
    return /mermaid/i.test(lang);
  }
  return false;
}

/** 挂到 crepe 根节点；返回 disconnect。 */
export function attachMermaidRenderer(root: HTMLElement): () => void {
  let scheduled = false;
  const scan = () => {
    scheduled = false;
    root.querySelectorAll("pre").forEach((pre) => {
      if (isMermaidBlock(pre)) void renderBlock(pre);
    });
    // Crepe 可能用 data-language 在父级
    root.querySelectorAll("[data-language='mermaid']").forEach((el) => {
      const pre =
        el.tagName === "PRE"
          ? el
          : el.querySelector("pre");
      if (pre instanceof HTMLElement) void renderBlock(pre);
    });
  };
  const kick = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  };
  const mo = new MutationObserver(kick);
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  kick();
  return () => mo.disconnect();
}
