// src/qr.ts
//
// The pairing code. Drawn here, never by an online QR service: the link
// holds the pairing secret.

import qrcode from "qrcode-generator";

const QUIET_ZONE = 4;
const SVG = "http://www.w3.org/2000/svg";

export function renderQr(target: HTMLElement, text: string): void {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const size = count + QUIET_ZONE * 2;
  let squares = "";
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) squares += `M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Pairing code");
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = document.createElementNS(SVG, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#ffffff");
  const modules = document.createElementNS(SVG, "path");
  modules.setAttribute("d", squares);
  modules.setAttribute("fill", "#000000");
  svg.append(background, modules);
  target.replaceChildren(svg);
}
