import { randomUUID } from "crypto";
import type { PanelWithListener } from "../types";
import * as vscode from "vscode";

export class PanelManager {
  private static panels = new Map<string, vscode.WebviewPanel>();

  static getOrCreatePanel(
    viewType: string,
    title: string,
    sessionId: string,
    variableName: string
  ): vscode.WebviewPanel {
    const key = `${viewType}:::${sessionId}:::${variableName}`;
    const existing = this.panels.get(key);

    if (existing) {
      existing.title = title;
      existing.reveal(vscode.ViewColumn.One);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });

    this.panels.set(key, panel);
    panel.onDidDispose(() => this.panels.delete(key));
    return panel;
  }
}

/** Set the page and reply only after that specific page has installed its listener. */
export function loadWebview(
  panel: PanelWithListener,
  html: string,
  data: Record<string, unknown>,
  onMessage?: (message: { command?: string; format?: "ascii" | "binary" }) => void | Promise<void>,
  onRelease?: () => void
): void {
  const ready = randomUUID();
  let sent = false;
  panel._messageListener?.dispose();
  const listener = panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === ready && !sent) {
      sent = await panel.webview.postMessage(data);
    } else if (sent) {
      await onMessage?.(message);
    }
  });
  const disposal = panel.onDidDispose(() => panel._messageListener?.dispose());
  panel._messageListener = { dispose() { listener.dispose(); disposal.dispose(); onRelease?.(); } };
  panel.webview.html = html.replace("__VIEWER_READY__", ready);
}
